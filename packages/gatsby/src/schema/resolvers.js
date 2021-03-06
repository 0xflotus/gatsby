const systemPath = require(`path`)
const normalize = require(`normalize-path`)
const _ = require(`lodash`)
const { GraphQLList, getNullableType, getNamedType, Kind } = require(`graphql`)
import { getValueAt } from "../utils/get-value-at"

const findMany = typeName => (source, args, context, info) => {
  if (context.stats) {
    context.stats.totalRunQuery++
    context.stats.totalPluralRunQuery++
  }

  return context.nodeModel.runQuery(
    {
      query: args,
      firstOnly: false,
      type: info.schema.getType(typeName),
      stats: context.stats,
    },
    { path: context.path, connectionType: typeName }
  )
}

const findOne = typeName => (source, args, context, info) => {
  if (context.stats) {
    context.stats.totalRunQuery++
  }
  return context.nodeModel.runQuery(
    {
      query: { filter: args },
      firstOnly: true,
      type: info.schema.getType(typeName),
      stats: context.stats,
    },
    { path: context.path }
  )
}

const findManyPaginated = typeName => async (source, args, context, info) => {
  // Peek into selection set and pass on the `field` arg of `group` and
  // `distinct` which might need to be resolved.
  const group = getProjectedField(info, `group`)
  const distinct = getProjectedField(info, `distinct`)
  const extendedArgs = { ...args, group: group || [], distinct: distinct || [] }

  const result = await findMany(typeName)(source, extendedArgs, context, info)
  return paginate(result, { skip: args.skip, limit: args.limit })
}

const distinct = (source, args, context, info) => {
  const { field } = args
  const { edges } = source
  const values = edges.reduce((acc, { node }) => {
    const value =
      getValueAt(node, `__gatsby_resolved.${field}`) || getValueAt(node, field)
    return value != null
      ? acc.concat(value instanceof Date ? value.toISOString() : value)
      : acc
  }, [])
  return Array.from(new Set(values)).sort()
}

const group = (source, args, context, info) => {
  const { field } = args
  const { edges } = source
  const groupedResults = edges.reduce((acc, { node }) => {
    const value =
      getValueAt(node, `__gatsby_resolved.${field}`) || getValueAt(node, field)
    const values = Array.isArray(value) ? value : [value]
    values
      .filter(value => value != null)
      .forEach(value => {
        const key = value instanceof Date ? value.toISOString() : value
        acc[key] = (acc[key] || []).concat(node)
      })
    return acc
    // Note: using Object.create on purpose:
    //   object key may be arbitrary string including reserved words (i.e. `constructor`)
    //   see: https://github.com/gatsbyjs/gatsby/issues/22508
  }, Object.create(null))

  return Object.keys(groupedResults)
    .sort()
    .reduce((acc, fieldValue) => {
      acc.push({
        ...paginate(groupedResults[fieldValue], args),
        field,
        fieldValue,
      })
      return acc
    }, [])
}

const paginate = (results = [], { skip = 0, limit }) => {
  if (results === null) {
    results = []
  }

  const count = results.length
  const items = results.slice(skip, limit && skip + limit)

  const pageCount = limit
    ? Math.ceil(skip / limit) + Math.ceil((count - skip) / limit)
    : skip
    ? 2
    : 1
  const currentPage = limit ? Math.ceil(skip / limit) + 1 : skip ? 2 : 1
  const hasPreviousPage = currentPage > 1
  const hasNextPage = skip + limit < count

  return {
    totalCount: count,
    edges: items.map((item, i, arr) => {
      return {
        node: item,
        next: arr[i + 1],
        previous: arr[i - 1],
      }
    }),
    nodes: items,
    pageInfo: {
      currentPage,
      hasPreviousPage,
      hasNextPage,
      itemCount: items.length,
      pageCount,
      perPage: limit,
    },
  }
}

const link = (options = {}, fieldConfig) => async (
  source,
  args,
  context,
  info
) => {
  const resolver = fieldConfig.resolve || context.defaultFieldResolver
  const fieldValue = await resolver(source, args, context, {
    ...info,
    from: options.from || info.from,
    fromNode: options.from ? options.fromNode : info.fromNode,
  })

  if (fieldValue == null) return null

  const returnType = getNullableType(options.type || info.returnType)
  const type = getNamedType(returnType)

  if (options.by === `id`) {
    if (Array.isArray(fieldValue)) {
      return context.nodeModel.getNodesByIds(
        { ids: fieldValue, type: type },
        { path: context.path }
      )
    } else {
      return context.nodeModel.getNodeById(
        { id: fieldValue, type: type },
        { path: context.path }
      )
    }
  }

  const equals = value => {
    return { eq: value }
  }
  const oneOf = value => {
    return { in: value }
  }

  // Return early if fieldValue is [] since { in: [] } doesn't make sense
  if (Array.isArray(fieldValue) && fieldValue.length === 0) {
    return fieldValue
  }

  const operator = Array.isArray(fieldValue) ? oneOf : equals
  args.filter = options.by.split(`.`).reduceRight((acc, key, i, { length }) => {
    return {
      [key]: i === length - 1 ? operator(acc) : acc,
    }
  }, fieldValue)

  const firstOnly = !(returnType instanceof GraphQLList)

  if (context.stats) {
    context.stats.totalRunQuery++
    if (firstOnly) {
      context.stats.totalPluralRunQuery++
    }
  }

  const result = await context.nodeModel.runQuery(
    { query: args, firstOnly, type, stats: context.stats },
    { path: context.path }
  )
  if (
    returnType instanceof GraphQLList &&
    Array.isArray(fieldValue) &&
    Array.isArray(result)
  ) {
    return fieldValue.map(value =>
      result.find(obj => getValueAt(obj, options.by) === value)
    )
  } else {
    return result
  }
}

const fileByPath = (options = {}, fieldConfig) => async (
  source,
  args,
  context,
  info
) => {
  const resolver = fieldConfig.resolve || context.defaultFieldResolver
  const fieldValue = await resolver(source, args, context, {
    ...info,
    from: options.from || info.from,
    fromNode: options.from ? options.fromNode : info.fromNode,
  })

  if (fieldValue == null) return null

  const findLinkedFileNode = relativePath => {
    // Use the parent File node to create the absolute path to
    // the linked file.
    const fileLinkPath = normalize(
      systemPath.resolve(parentFileNode.dir, relativePath)
    )

    // Use that path to find the linked File node.
    const linkedFileNode = _.find(
      context.nodeModel.getAllNodes({ type: `File` }),
      n => n.absolutePath === fileLinkPath
    )
    return linkedFileNode
  }

  // Find the File node for this node (we assume the node is something
  // like markdown which would be a child node of a File node).
  const parentFileNode = context.nodeModel.findRootNodeAncestor(
    source,
    node => node.internal && node.internal.type === `File`
  )

  return resolveValue(findLinkedFileNode, fieldValue)
}

const resolveValue = (resolve, value) =>
  Array.isArray(value)
    ? value.map(v => resolveValue(resolve, v))
    : resolve(value)

const getProjectedField = (info, fieldName) => {
  const selectionSet = info.fieldNodes[0].selectionSet
  const fieldNodes = getFieldNodeByNameInSelectionSet(
    selectionSet,
    fieldName,
    info
  )

  const fieldEnum = getNullableType(
    getNullableType(info.returnType)
      .getFields()
      [fieldName].args.find(arg => arg.name === `field`).type
  )

  return fieldNodes.reduce((acc, fieldNode) => {
    const fieldArg = fieldNode.arguments.find(arg => arg.name.value === `field`)
    if (fieldArg) {
      const enumKey = fieldArg.value.value
      return [...acc, fieldEnum.getValue(enumKey).value]
    } else {
      return acc
    }
  }, [])
}

const getFieldNodeByNameInSelectionSet = (selectionSet, fieldName, info) =>
  selectionSet.selections.reduce((acc, selection) => {
    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragmentDef = info.fragments[selection.name.value]
      if (fragmentDef) {
        return [
          ...acc,
          ...getFieldNodeByNameInSelectionSet(
            fragmentDef.selectionSet,
            fieldName,
            info
          ),
        ]
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      return [
        ...acc,
        ...getFieldNodeByNameInSelectionSet(
          selection.selectionSet,
          fieldName,
          info
        ),
      ]
    } /* FIELD_NODE */ else {
      if (selection.name.value === fieldName) {
        return [...acc, selection]
      }
    }
    return acc
  }, [])

const defaultFieldResolver = (source, args, context, info) => {
  if (!source || typeof source !== `object`) return null

  if (info.from) {
    if (info.fromNode) {
      const node = context.nodeModel.findRootNodeAncestor(source)
      if (!node) return null
      return getValueAt(node, info.from)
    }
    return getValueAt(source, info.from)
  }

  return source[info.fieldName]
}

module.exports = {
  defaultFieldResolver,
  findManyPaginated,
  findOne,
  fileByPath,
  link,
  distinct,
  group,
  paginate,
}
