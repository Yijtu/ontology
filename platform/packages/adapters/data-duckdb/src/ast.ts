import { SqlLexError, isKeyword, tokenize } from './lexer'
import type { SqlToken } from './lexer'

/**
 * A real (if deliberately small) abstract syntax tree for the read-only query subset
 * (SPEC C3). The sandbox decision is made from this tree, never from the raw string:
 * a `SELECT` prefix, a `WHERE` in a comment or a `;`-hidden second statement are all
 * irrelevant here because the lexer already normalised them away.
 *
 * The grammar only models single read-only `SELECT` statements, controlled CTEs, set
 * operations, joins over registered relations and bounded expressions. Anything else —
 * DDL/DML, writable CTEs, `ATTACH`/`INSTALL`/`LOAD`, table functions, recursive CTEs,
 * `SELECT ... INTO` — has no production and is rejected at parse time.
 */

export class SqlParseError extends Error {
  readonly offset: number

  constructor(message: string, offset: number) {
    super(message)
    this.name = 'SqlParseError'
    this.offset = offset
  }
}

export type SqlExpression =
  | { readonly kind: 'literal'; readonly literal: SqlLiteralKind }
  | { readonly kind: 'parameter' }
  | { readonly kind: 'column'; readonly parts: readonly string[] }
  | { readonly kind: 'star'; readonly qualifier: readonly string[] }
  | {
      readonly kind: 'call'
      readonly name: string
      readonly args: readonly SqlExpression[]
      readonly distinct: boolean
      readonly star: boolean
    }
  | { readonly kind: 'unary'; readonly op: string; readonly operand: SqlExpression }
  | {
      readonly kind: 'binary'
      readonly op: string
      readonly left: SqlExpression
      readonly right: SqlExpression
    }
  | { readonly kind: 'cast'; readonly operand: SqlExpression; readonly targetType: string }
  | {
      readonly kind: 'case'
      readonly branches: readonly { readonly when: SqlExpression; readonly then: SqlExpression }[]
      readonly else?: SqlExpression
    }
  | {
      readonly kind: 'in'
      readonly operand: SqlExpression
      readonly negated: boolean
      readonly values?: readonly SqlExpression[]
      readonly subquery?: SqlQuery
    }
  | {
      readonly kind: 'between'
      readonly operand: SqlExpression
      readonly negated: boolean
      readonly low: SqlExpression
      readonly high: SqlExpression
    }
  | {
      readonly kind: 'is'
      readonly operand: SqlExpression
      readonly negated: boolean
      readonly target: 'null' | 'true' | 'false' | 'unknown' | 'distinct'
      readonly right?: SqlExpression
    }
  | { readonly kind: 'exists'; readonly negated: boolean; readonly subquery: SqlQuery }
  | { readonly kind: 'subquery'; readonly query: SqlQuery }
  | { readonly kind: 'tuple'; readonly items: readonly SqlExpression[] }

export type SqlLiteralKind =
  | 'number'
  | 'string'
  | 'boolean'
  | 'null'
  | 'interval'
  | 'date'
  | 'time'
  | 'timestamp'

export interface SqlRelation {
  readonly kind: 'relation'
  readonly parts: readonly string[]
  readonly alias?: string
}

export interface SqlDerivedTable {
  readonly kind: 'derived'
  readonly query: SqlQuery
  readonly alias?: string
}

/**
 * A table function in FROM (`read_csv(...)`, `glob(...)`, `query(...)`). It is parsed so
 * the sandbox can name the exact function in its rejection; the default allowlist is
 * empty, so every table function is refused before execution.
 */
export interface SqlTableFunction {
  readonly kind: 'tableFunction'
  readonly name: string
  readonly args: readonly SqlExpression[]
  readonly alias?: string
}

export type SqlFromItem = SqlRelation | SqlDerivedTable | SqlTableFunction

export type SqlJoinType = 'inner' | 'left' | 'right' | 'full' | 'cross' | 'natural'

export interface SqlJoin {
  readonly joinType: SqlJoinType
  readonly item: SqlFromItem
  readonly on?: SqlExpression
  readonly using?: readonly string[]
}

export interface SqlSelect {
  readonly kind: 'select'
  readonly distinct: boolean
  readonly columns: readonly SqlExpression[]
  readonly from: readonly SqlFromItem[]
  readonly joins: readonly SqlJoin[]
  readonly where?: SqlExpression
  readonly groupBy: readonly SqlExpression[]
  readonly having?: SqlExpression
  readonly qualify?: SqlExpression
}

export interface SqlSetOperation {
  readonly kind: 'set'
  readonly operator: 'UNION' | 'INTERSECT' | 'EXCEPT'
  readonly all: boolean
  readonly left: SqlSelectBody
  readonly right: SqlSelectBody
}

export type SqlSelectBody = SqlSelect | SqlSetOperation

export interface SqlOrderBy {
  readonly expression: SqlExpression
  readonly direction: 'asc' | 'desc'
}

export interface SqlCte {
  readonly name: string
  readonly query: SqlQuery
  readonly columnAliases: readonly string[]
}

export interface SqlQuery {
  readonly kind: 'query'
  readonly ctes: readonly SqlCte[]
  readonly body: SqlSelectBody
  readonly orderBy: readonly SqlOrderBy[]
  readonly limit?: SqlExpression
  readonly offset?: SqlExpression
}

export interface ParsedStatement {
  readonly query: SqlQuery
  /** Source offset of the last significant token; trailing comments are excluded. */
  readonly endOffset: number
}

const CLAUSE_KEYWORDS: ReadonlySet<string> = new Set([
  'ALL',
  'AND',
  'AS',
  'ASC',
  'BY',
  'CROSS',
  'DESC',
  'DISTINCT',
  'ELSE',
  'END',
  'EXCEPT',
  'FETCH',
  'FIRST',
  'FROM',
  'FULL',
  'GROUP',
  'HAVING',
  'ILIKE',
  'INNER',
  'INTERSECT',
  'INTO',
  'JOIN',
  'LAST',
  'LEFT',
  'LIKE',
  'LIMIT',
  'NATURAL',
  'NOT',
  'NULLS',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'QUALIFY',
  'RIGHT',
  'SIMILAR',
  'THEN',
  'UNION',
  'USING',
  'WHEN',
  'WHERE',
  'WINDOW',
  'WITH',
])

const JOIN_STARTERS: ReadonlySet<string> = new Set([
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
])

const TYPE_WORD_KEYWORDS: ReadonlySet<string> = new Set(['TIMESTAMP', 'TIME', 'WITH'])

const ALLOWED_CAST_TYPES: ReadonlySet<string> = new Set([
  'BOOLEAN',
  'BOOL',
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'INT',
  'BIGINT',
  'HUGEINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'FLOAT',
  'REAL',
  'DOUBLE',
  'DOUBLE PRECISION',
  'DECIMAL',
  'NUMERIC',
  'VARCHAR',
  'TEXT',
  'STRING',
  'CHAR',
  'CHARACTER',
  'CHARACTER VARYING',
  'BLOB',
  'BYTEA',
  'DATE',
  'TIME',
  'TIMESTAMP',
  'TIMESTAMP WITH TIME ZONE',
  'TIMESTAMPTZ',
  'UUID',
  'JSON',
  'INTERVAL',
  'BIT',
])

/**
 * Split a token stream into statements on top-level `;`. Because strings and comments
 * are already single tokens, a `;` token is always a real statement separator, so a
 * `;` hidden inside a string or comment cannot create a phantom statement.
 */
export function splitStatements(tokens: readonly SqlToken[]): SqlToken[][] {
  const statements: SqlToken[][] = []
  const endToken: SqlToken = tokens[tokens.length - 1] ?? {
    kind: 'end',
    text: '',
    upper: '',
    start: 0,
    end: 0,
  }
  let current: SqlToken[] = []
  for (const token of tokens) {
    if (token.kind === 'end') break
    if (token.text === ';') {
      if (current.length > 0) statements.push([...current, endToken])
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) statements.push([...current, endToken])
  return statements
}

function isMeaningful(tokens: readonly SqlToken[]): boolean {
  return tokens.some((token) => token.kind !== 'end')
}

/** Parse one statement's tokens into a `SqlQuery`. */
export function parseStatement(tokens: readonly SqlToken[]): ParsedStatement {
  const parser = new Parser(tokens)
  const query = parser.parseQuery()
  const next = parser.peek()
  if (next.kind !== 'end') {
    throw new SqlParseError(`unexpected token "${next.text}" after the query`, next.start)
  }
  return { query, endOffset: parser.endOffset }
}

export function parseSql(sql: string): ParsedStatement {
  const tokens = tokenize(sql)
  const statements = splitStatements(tokens).filter(isMeaningful)
  if (statements.length !== 1) {
    throw new SqlParseError(
      statements.length === 0 ? 'the statement is empty' : 'only a single statement is allowed',
      0,
    )
  }
  const first = statements[0]
  if (first === undefined) throw new SqlParseError('the statement is empty', 0)
  return parseStatement(first)
}

/** Convenience: tokenize + single-statement check + parse. */
export function parseSingleStatement(sql: string): ParsedStatement {
  return parseSql(sql)
}

export interface SqlFacts {
  readonly relations: readonly string[]
  readonly functions: readonly string[]
  readonly tableFunctions: readonly string[]
  readonly cteNames: readonly string[]
  readonly parameters: number
  readonly hasExplicitLimit: boolean
  readonly hasExplicitOffset: boolean
  readonly hasRecursiveCte: boolean
  readonly hasSubquery: boolean
}

/**
 * Walk the AST once and collect everything the sandbox allowlist must reason about.
 * Referenced relations keep the name as written (lower-cased) so the adapter can map
 * them back to a registered object.
 */
export function collectFacts(query: SqlQuery): SqlFacts {
  const relations = new Set<string>()
  const functions = new Set<string>()
  const tableFunctions = new Set<string>()
  const cteNames = new Set<string>()
  const state = { parameters: 0, hasSubquery: false, hasRecursiveCte: false }

  const visitQuery = (node: SqlQuery): void => {
    for (const cte of node.ctes) {
      cteNames.add(cte.name.toLowerCase())
      visitQuery(cte.query)
    }
    visitBody(node.body)
    for (const order of node.orderBy) visitExpression(order.expression)
    if (node.limit !== undefined) visitExpression(node.limit)
    if (node.offset !== undefined) visitExpression(node.offset)
  }

  const visitBody = (body: SqlSelectBody): void => {
    if (body.kind === 'set') {
      visitBody(body.left)
      visitBody(body.right)
      return
    }
    for (const column of body.columns) visitExpression(column)
    for (const item of body.from) visitFromItem(item)
    for (const join of body.joins) {
      visitFromItem(join.item)
      if (join.on !== undefined) visitExpression(join.on)
    }
    if (body.where !== undefined) visitExpression(body.where)
    for (const group of body.groupBy) visitExpression(group)
    if (body.having !== undefined) visitExpression(body.having)
    if (body.qualify !== undefined) visitExpression(body.qualify)
  }

  const visitFromItem = (item: SqlFromItem): void => {
    if (item.kind === 'relation') {
      relations.add(item.parts.join('.').toLowerCase())
      return
    }
    if (item.kind === 'tableFunction') {
      tableFunctions.add(item.name.toLowerCase())
      for (const arg of item.args) visitExpression(arg)
      return
    }
    state.hasSubquery = true
    visitQuery(item.query)
  }

  const visitExpression = (expression: SqlExpression): void => {
    switch (expression.kind) {
      case 'literal':
        return
      case 'parameter':
        state.parameters += 1
        return
      case 'column':
      case 'star':
        return
      case 'call':
        functions.add(expression.name.toLowerCase())
        for (const arg of expression.args) visitExpression(arg)
        return
      case 'unary':
        visitExpression(expression.operand)
        return
      case 'binary':
        visitExpression(expression.left)
        visitExpression(expression.right)
        return
      case 'cast':
        visitExpression(expression.operand)
        return
      case 'case':
        for (const branch of expression.branches) {
          visitExpression(branch.when)
          visitExpression(branch.then)
        }
        if (expression.else !== undefined) visitExpression(expression.else)
        return
      case 'in':
        visitExpression(expression.operand)
        for (const value of expression.values ?? []) visitExpression(value)
        if (expression.subquery !== undefined) {
          state.hasSubquery = true
          visitQuery(expression.subquery)
        }
        return
      case 'between':
        visitExpression(expression.operand)
        visitExpression(expression.low)
        visitExpression(expression.high)
        return
      case 'is':
        visitExpression(expression.operand)
        if (expression.right !== undefined) visitExpression(expression.right)
        return
      case 'exists':
        state.hasSubquery = true
        visitQuery(expression.subquery)
        return
      case 'subquery':
        state.hasSubquery = true
        visitQuery(expression.query)
        return
      case 'tuple':
        for (const item of expression.items) visitExpression(item)
        return
    }
  }

  visitQuery(query)

  return {
    relations: [...relations].filter((name) => !cteNames.has(name)),
    functions: [...functions],
    tableFunctions: [...tableFunctions],
    cteNames: [...cteNames],
    parameters: state.parameters,
    hasExplicitLimit: query.limit !== undefined,
    hasExplicitOffset: query.offset !== undefined,
    hasRecursiveCte: state.hasRecursiveCte,
    hasSubquery: state.hasSubquery,
  }
}

class Parser {
  readonly #tokens: readonly SqlToken[]
  #position = 0

  constructor(tokens: readonly SqlToken[]) {
    this.#tokens = tokens
  }

  get endOffset(): number {
    let last = 0
    for (const token of this.#tokens) {
      if (token.kind !== 'end') last = token.end
    }
    return last
  }

  peek(offset = 0): SqlToken {
    const token = this.#tokens[this.#position + offset]
    if (token !== undefined) return token
    // The token stream always ends with an `end` token, so out-of-range lookahead
    // clamps to it instead of throwing; the parser then reports a precise expected token.
    const last = this.#tokens[this.#tokens.length - 1]
    if (last === undefined) throw new SqlParseError('unexpected end of input', 0)
    return last
  }

  #matchKeyword(keyword: string): boolean {
    if (isKeyword(this.peek(), keyword)) {
      this.#position += 1
      return true
    }
    return false
  }

  #expectKeyword(keyword: string): void {
    const token = this.peek()
    if (!isKeyword(token, keyword)) {
      throw new SqlParseError(`expected ${keyword} but found "${token.text}"`, token.start)
    }
    this.#position += 1
  }

  #matchPunctuation(text: string): boolean {
    const token = this.peek()
    if (token.kind === 'punctuation' && token.text === text) {
      this.#position += 1
      return true
    }
    return false
  }

  #expectPunctuation(text: string): void {
    const token = this.peek()
    if (token.kind !== 'punctuation' || token.text !== text) {
      throw new SqlParseError(`expected "${text}" but found "${token.text}"`, token.start)
    }
    this.#position += 1
  }

  #expectIdentifier(what: string): string {
    const token = this.peek()
    if (token.kind !== 'identifier') {
      throw new SqlParseError(`expected ${what} but found "${token.text}"`, token.start)
    }
    this.#position += 1
    return token.text
  }

  #isSelectStart(): boolean {
    const token = this.peek()
    return isKeyword(token, 'SELECT') || isKeyword(token, 'WITH')
  }

  #isJoinStart(): boolean {
    const token = this.peek()
    return token.kind === 'keyword' && JOIN_STARTERS.has(token.upper)
  }

  parseQuery(): SqlQuery {
    const ctes: SqlCte[] = []
    if (this.#matchKeyword('WITH')) {
      if (this.#matchKeyword('RECURSIVE')) {
        const token = this.peek()
        throw new SqlParseError('recursive CTEs are not permitted', token.start)
      }
      for (;;) {
        const name = this.#expectIdentifier('a CTE name')
        this.#expectKeyword('AS')
        this.#expectPunctuation('(')
        const query = this.parseQuery()
        this.#expectPunctuation(')')
        const columnAliases: string[] = []
        if (this.#matchPunctuation('(')) {
          for (;;) {
            columnAliases.push(this.#expectIdentifier('a column alias'))
            if (!this.#matchPunctuation(',')) break
          }
          this.#expectPunctuation(')')
        }
        ctes.push({ name, query, columnAliases })
        if (!this.#matchPunctuation(',')) break
      }
    }
    const body = this.#parseSetBody()
    const orderBy: SqlOrderBy[] = []
    if (this.#matchKeyword('ORDER')) {
      this.#expectKeyword('BY')
      for (;;) {
        const expression = this.#parseExpression()
        let direction: 'asc' | 'desc' = 'asc'
        if (this.#matchKeyword('DESC')) direction = 'desc'
        else if (this.#matchKeyword('ASC')) direction = 'asc'
        if (this.#matchKeyword('NULLS')) {
          if (!this.#matchKeyword('FIRST')) this.#expectKeyword('LAST')
        }
        orderBy.push({ expression, direction })
        if (!this.#matchPunctuation(',')) break
      }
    }
    let limit: SqlExpression | undefined
    let offset: SqlExpression | undefined
    if (this.#matchKeyword('LIMIT')) {
      if (!this.#matchKeyword('ALL')) limit = this.#parseExpression()
    }
    if (this.#matchKeyword('OFFSET')) {
      offset = this.#parseExpression()
      if (this.#matchKeyword('ROW') || this.#matchKeyword('ROWS')) {
        // tolerated
      }
    }
    const query: SqlQuery = {
      kind: 'query',
      ctes,
      body,
      orderBy,
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    }
    return query
  }

  #parseSetBody(): SqlSelectBody {
    let left: SqlSelectBody = this.#parseSelectCore()
    for (;;) {
      const token = this.peek()
      if (
        !isKeyword(token, 'UNION') &&
        !isKeyword(token, 'INTERSECT') &&
        !isKeyword(token, 'EXCEPT')
      ) {
        break
      }
      const operator = token.upper as 'UNION' | 'INTERSECT' | 'EXCEPT'
      this.#position += 1
      let all = false
      if (this.#matchKeyword('ALL')) all = true
      else if (this.#matchKeyword('DISTINCT')) all = false
      const right = this.#parseSelectCore()
      left = { kind: 'set', operator, all, left, right }
    }
    return left
  }

  #parseSelectCore(): SqlSelect {
    this.#expectKeyword('SELECT')
    let distinct = false
    if (this.#matchKeyword('DISTINCT')) distinct = true
    else if (this.#matchKeyword('ALL')) distinct = false

    const columns: SqlExpression[] = []
    for (;;) {
      columns.push(this.#parseSelectItem())
      if (!this.#matchPunctuation(',')) break
    }

    const from: SqlFromItem[] = []
    const joins: SqlJoin[] = []
    if (this.#matchKeyword('FROM')) {
      for (;;) {
        this.#parseFromElement(from, joins)
        while (this.#isJoinStart()) this.#parseJoin(joins)
        if (!this.#matchPunctuation(',')) break
      }
    }

    let where: SqlExpression | undefined
    let having: SqlExpression | undefined
    let qualify: SqlExpression | undefined
    const groupBy: SqlExpression[] = []
    if (this.#matchKeyword('WHERE')) where = this.#parseExpression()
    if (this.#matchKeyword('GROUP')) {
      this.#expectKeyword('BY')
      for (;;) {
        groupBy.push(this.#parseExpression())
        if (!this.#matchPunctuation(',')) break
      }
    }
    if (this.#matchKeyword('HAVING')) having = this.#parseExpression()
    if (this.#matchKeyword('QUALIFY')) qualify = this.#parseExpression()
    const window = this.peek()
    if (isKeyword(window, 'WINDOW')) {
      throw new SqlParseError('WINDOW clauses are not permitted', window.start)
    }
    const into = this.peek()
    if (isKeyword(into, 'INTO')) {
      throw new SqlParseError('SELECT ... INTO is not permitted', into.start)
    }
    return {
      kind: 'select',
      distinct,
      columns,
      from,
      joins,
      groupBy,
      ...(where === undefined ? {} : { where }),
      ...(having === undefined ? {} : { having }),
      ...(qualify === undefined ? {} : { qualify }),
    }
  }

  #parseSelectItem(): SqlExpression {
    const token = this.peek()
    if (token.kind === 'punctuation' && token.text === '*') {
      this.#position += 1
      return { kind: 'star', qualifier: [] }
    }
    const qualifier: string[] = []
    let lookahead = 0
    for (;;) {
      const part = this.peek(lookahead)
      const dot = this.peek(lookahead + 1)
      const after = this.peek(lookahead + 2)
      if (part.kind !== 'identifier' || dot.text !== '.') break
      if (after.kind === 'punctuation' && after.text === '*') {
        qualifier.push(part.text)
        this.#position += lookahead + 3
        return { kind: 'star', qualifier }
      }
      if (after.kind !== 'identifier') break
      qualifier.push(part.text)
      lookahead += 2
    }
    const expression = this.#parseExpression()
    if (this.#matchKeyword('AS')) {
      this.#expectIdentifier('a column alias')
    } else {
      const next = this.peek()
      if (next.kind === 'identifier' && !CLAUSE_KEYWORDS.has(next.upper)) this.#position += 1
    }
    return expression
  }

  #parseFromElement(items: SqlFromItem[], joins: SqlJoin[]): void {
    const token = this.peek()
    if (token.kind === 'punctuation' && token.text === '(') {
      if (this.#isSelectStartAt(1)) {
        this.#position += 1
        const query = this.parseQuery()
        this.#expectPunctuation(')')
        const alias = this.#parseOptionalAlias()
        items.push({ kind: 'derived', query, ...(alias === undefined ? {} : { alias }) })
        return
      }
      this.#position += 1
      for (;;) {
        this.#parseFromElement(items, joins)
        while (this.#isJoinStart()) this.#parseJoin(joins)
        if (!this.#matchPunctuation(',')) break
      }
      this.#expectPunctuation(')')
      this.#parseOptionalAlias()
      return
    }
    const parts = this.#parseQualifiedName('a relation name')
    if (this.peek().kind === 'punctuation' && this.peek().text === '(') {
      const call = this.#parseCall(parts[parts.length - 1] ?? '')
      if (call.kind !== 'call') {
        throw new SqlParseError('expected a table function call', token.start)
      }
      const alias = this.#parseOptionalAlias()
      items.push({
        kind: 'tableFunction',
        name: call.name,
        args: call.args,
        ...(alias === undefined ? {} : { alias }),
      })
      return
    }
    const alias = this.#parseOptionalAlias()
    items.push({ kind: 'relation', parts, ...(alias === undefined ? {} : { alias }) })
  }

  #parseJoin(joins: SqlJoin[]): void {
    let joinType: SqlJoinType = 'inner'
    if (this.#matchKeyword('NATURAL')) {
      joinType = 'natural'
      if (this.#matchKeyword('LEFT') || this.#matchKeyword('RIGHT') || this.#matchKeyword('FULL')) {
        this.#matchKeyword('OUTER')
      } else if (this.#matchKeyword('INNER')) {
        // tolerated
      }
      this.#expectKeyword('JOIN')
    } else if (this.#matchKeyword('CROSS')) {
      joinType = 'cross'
      this.#expectKeyword('JOIN')
    } else {
      if (this.#matchKeyword('LEFT')) joinType = 'left'
      else if (this.#matchKeyword('RIGHT')) joinType = 'right'
      else if (this.#matchKeyword('FULL')) joinType = 'full'
      else if (this.#matchKeyword('INNER')) joinType = 'inner'
      if (joinType !== 'inner' || this.peek().upper === 'OUTER') this.#matchKeyword('OUTER')
      this.#expectKeyword('JOIN')
    }

    const items: SqlFromItem[] = []
    const nestedJoins: SqlJoin[] = []
    this.#parseFromElement(items, nestedJoins)
    const item = items[0]
    if (item === undefined) {
      const token = this.peek()
      throw new SqlParseError('expected a join target', token.start)
    }
    let on: SqlExpression | undefined
    let using: string[] | undefined
    if (this.#matchKeyword('ON')) {
      on = this.#parseExpression()
    } else if (this.#matchKeyword('USING')) {
      this.#expectPunctuation('(')
      using = []
      for (;;) {
        using.push(this.#expectIdentifier('a column name'))
        if (!this.#matchPunctuation(',')) break
      }
      this.#expectPunctuation(')')
    }
    joins.push({
      joinType,
      item,
      ...(on === undefined ? {} : { on }),
      ...(using === undefined ? {} : { using }),
    })
  }

  #isSelectStartAt(offset: number): boolean {
    const token = this.peek(offset)
    return isKeyword(token, 'SELECT') || isKeyword(token, 'WITH')
  }

  #parseOptionalAlias(): string | undefined {
    if (this.#matchKeyword('AS')) return this.#expectIdentifier('an alias')
    const token = this.peek()
    if (token.kind === 'identifier' && !CLAUSE_KEYWORDS.has(token.upper)) {
      this.#position += 1
      return token.text
    }
    return undefined
  }

  #parseQualifiedName(what: string): string[] {
    const parts = [this.#expectIdentifier(what)]
    for (;;) {
      const dot = this.peek()
      const after = this.peek(1)
      if (dot.kind === 'punctuation' && dot.text === '.' && after.kind === 'identifier') {
        this.#position += 2
        parts.push(after.text)
        continue
      }
      break
    }
    return parts
  }

  #parseExpression(): SqlExpression {
    return this.#parseOr()
  }

  #parseOr(): SqlExpression {
    let left = this.#parseAnd()
    while (this.#matchKeyword('OR')) {
      const right = this.#parseAnd()
      left = { kind: 'binary', op: 'OR', left, right }
    }
    return left
  }

  #parseAnd(): SqlExpression {
    let left = this.#parseNot()
    while (this.#matchKeyword('AND')) {
      const right = this.#parseNot()
      left = { kind: 'binary', op: 'AND', left, right }
    }
    return left
  }

  #parseNot(): SqlExpression {
    if (this.#matchKeyword('NOT')) {
      const operand = this.#parseNot()
      return { kind: 'unary', op: 'NOT', operand }
    }
    return this.#parseComparison()
  }

  #parseComparison(): SqlExpression {
    let left = this.#parseAdditive()
    for (;;) {
      const token = this.peek()
      if (
        (token.kind === 'operator' || token.kind === 'punctuation') &&
        ['=', '<>', '!=', '<', '<=', '>', '>='].includes(token.text)
      ) {
        this.#position += 1
        const right = this.#parseAdditive()
        left = { kind: 'binary', op: token.text, left, right }
        continue
      }
      if (isKeyword(token, 'IS')) {
        this.#position += 1
        const negated = this.#matchKeyword('NOT')
        if (this.#matchKeyword('NULL')) {
          left = { kind: 'is', operand: left, negated, target: 'null' }
          continue
        }
        if (this.#matchKeyword('TRUE')) {
          left = { kind: 'is', operand: left, negated, target: 'true' }
          continue
        }
        if (this.#matchKeyword('FALSE')) {
          left = { kind: 'is', operand: left, negated, target: 'false' }
          continue
        }
        if (this.#matchKeyword('UNKNOWN')) {
          left = { kind: 'is', operand: left, negated, target: 'unknown' }
          continue
        }
        if (this.#matchKeyword('DISTINCT')) {
          this.#expectKeyword('FROM')
          const right = this.#parseAdditive()
          left = { kind: 'is', operand: left, negated, target: 'distinct', right }
          continue
        }
        throw new SqlParseError(`unsupported IS predicate at "${token.text}"`, token.start)
      }
      const negated = isKeyword(this.peek(), 'NOT') && this.#isInfixKeywordAt(1)
      if (negated) this.#position += 1
      const operator = this.peek()
      if (isKeyword(operator, 'IN')) {
        this.#position += 1
        this.#expectPunctuation('(')
        if (this.#isSelectStart()) {
          const subquery = this.parseQuery()
          this.#expectPunctuation(')')
          left = { kind: 'in', operand: left, negated, subquery }
        } else {
          const values: SqlExpression[] = []
          for (;;) {
            values.push(this.#parseExpression())
            if (!this.#matchPunctuation(',')) break
          }
          this.#expectPunctuation(')')
          left = { kind: 'in', operand: left, negated, values }
        }
        continue
      }
      if (isKeyword(operator, 'BETWEEN')) {
        this.#position += 1
        const low = this.#parseAdditive()
        this.#expectKeyword('AND')
        const high = this.#parseAdditive()
        left = { kind: 'between', operand: left, negated, low, high }
        continue
      }
      if (isKeyword(operator, 'LIKE') || isKeyword(operator, 'ILIKE')) {
        this.#position += 1
        const right = this.#parseAdditive()
        left = { kind: 'binary', op: operator.upper, left, right }
        continue
      }
      if (isKeyword(operator, 'SIMILAR')) {
        this.#position += 1
        this.#expectKeyword('TO')
        const right = this.#parseAdditive()
        left = { kind: 'binary', op: 'SIMILAR TO', left, right }
        continue
      }
      if (negated) {
        throw new SqlParseError(`unsupported NOT predicate at "${operator.text}"`, operator.start)
      }
      break
    }
    return left
  }

  #isInfixKeywordAt(offset: number): boolean {
    const token = this.peek(offset)
    return (
      isKeyword(token, 'IN') ||
      isKeyword(token, 'BETWEEN') ||
      isKeyword(token, 'LIKE') ||
      isKeyword(token, 'ILIKE') ||
      isKeyword(token, 'SIMILAR')
    )
  }

  #parseAdditive(): SqlExpression {
    let left = this.#parseMultiplicative()
    for (;;) {
      const token = this.peek()
      if (token.kind === 'punctuation' && (token.text === '+' || token.text === '-')) {
        this.#position += 1
        const right = this.#parseMultiplicative()
        left = { kind: 'binary', op: token.text, left, right }
        continue
      }
      break
    }
    return left
  }

  #parseMultiplicative(): SqlExpression {
    let left = this.#parseConcat()
    for (;;) {
      const token = this.peek()
      if (token.kind === 'punctuation' && (token.text === '*' || token.text === '/' || token.text === '%')) {
        this.#position += 1
        const right = this.#parseConcat()
        left = { kind: 'binary', op: token.text, left, right }
        continue
      }
      break
    }
    return left
  }

  #parseConcat(): SqlExpression {
    let left = this.#parseUnary()
    while (this.peek().kind === 'operator' && this.peek().text === '||') {
      this.#position += 1
      const right = this.#parseUnary()
      left = { kind: 'binary', op: '||', left, right }
    }
    return left
  }

  #parseUnary(): SqlExpression {
    const token = this.peek()
    if (token.kind === 'punctuation' && (token.text === '+' || token.text === '-')) {
      this.#position += 1
      const operand = this.#parseUnary()
      return { kind: 'unary', op: token.text, operand }
    }
    return this.#parsePostfix()
  }

  #parsePostfix(): SqlExpression {
    let expression = this.#parsePrimary()
    for (;;) {
      const token = this.peek()
      if (token.kind === 'operator' && token.text === '::') {
        this.#position += 1
        const targetType = this.#parseTypeName()
        expression = { kind: 'cast', operand: expression, targetType }
        continue
      }
      if (token.kind === 'punctuation' && token.text === '[') {
        this.#position += 1
        this.#parseExpression()
        this.#expectPunctuation(']')
        continue
      }
      if (token.kind === 'punctuation' && token.text === '.') {
        const after = this.peek(1)
        if (after.kind === 'identifier') {
          this.#position += 2
          continue
        }
      }
      break
    }
    return expression
  }

  #parsePrimary(): SqlExpression {
    const token = this.peek()
    if (token.kind === 'number') {
      this.#position += 1
      return { kind: 'literal', literal: 'number' }
    }
    if (token.kind === 'string') {
      this.#position += 1
      return { kind: 'literal', literal: 'string' }
    }
    if (token.kind === 'parameter') {
      this.#position += 1
      return { kind: 'parameter' }
    }
    if (token.kind === 'punctuation' && token.text === '(') {
      this.#position += 1
      if (this.#isSelectStart()) {
        const query = this.parseQuery()
        this.#expectPunctuation(')')
        return { kind: 'subquery', query }
      }
      const first = this.#parseExpression()
      if (this.#matchPunctuation(',')) {
        const items = [first]
        for (;;) {
          items.push(this.#parseExpression())
          if (!this.#matchPunctuation(',')) break
        }
        this.#expectPunctuation(')')
        return { kind: 'tuple', items }
      }
      this.#expectPunctuation(')')
      return first
    }
    if (token.kind === 'identifier') {
      const parts = this.#parseQualifiedName('an identifier')
      if (this.peek().kind === 'punctuation' && this.peek().text === '(') {
        return this.#parseCall(parts[parts.length - 1] ?? '')
      }
      return { kind: 'column', parts }
    }
    if (isKeyword(token, 'NULL')) {
      this.#position += 1
      return { kind: 'literal', literal: 'null' }
    }
    if (isKeyword(token, 'TRUE') || isKeyword(token, 'FALSE')) {
      this.#position += 1
      return { kind: 'literal', literal: 'boolean' }
    }
    if (isKeyword(token, 'CASE')) return this.#parseCase()
    if (isKeyword(token, 'CAST')) return this.#parseCast()
    if (isKeyword(token, 'EXISTS')) {
      this.#position += 1
      this.#expectPunctuation('(')
      const subquery = this.parseQuery()
      this.#expectPunctuation(')')
      return { kind: 'exists', negated: false, subquery }
    }
    if (isKeyword(token, 'INTERVAL')) {
      this.#position += 1
      const literal = this.peek()
      if (literal.kind !== 'string') {
        throw new SqlParseError('INTERVAL requires a quoted literal in this subset', literal.start)
      }
      this.#position += 1
      return { kind: 'literal', literal: 'interval' }
    }
    if (isKeyword(token, 'DATE') || isKeyword(token, 'TIME') || isKeyword(token, 'TIMESTAMP') || isKeyword(token, 'TIMESTAMPTZ')) {
      const keyword = token.upper
      this.#position += 1
      this.#matchKeyword('WITH')
      this.#matchKeyword('TIME')
      this.#matchKeyword('ZONE')
      this.#matchKeyword('WITHOUT')
      const literal = this.peek()
      if (literal.kind !== 'string') {
        throw new SqlParseError(`${keyword} requires a quoted literal`, literal.start)
      }
      this.#position += 1
      const kind = keyword === 'DATE' ? 'date' : keyword === 'TIME' ? 'time' : 'timestamp'
      return { kind: 'literal', literal: kind }
    }
    throw new SqlParseError(`unexpected token "${token.text}"`, token.start)
  }

  #parseCall(name: string): SqlExpression {
    this.#expectPunctuation('(')
    const distinct = this.#matchKeyword('DISTINCT')
    let star = false
    const args: SqlExpression[] = []
    if (this.peek().kind === 'punctuation' && this.peek().text === '*') {
      this.#position += 1
      star = true
    } else if (!(this.peek().kind === 'punctuation' && this.peek().text === ')')) {
      for (;;) {
        args.push(this.#parseExpression())
        if (!this.#matchPunctuation(',')) break
      }
    }
    this.#expectPunctuation(')')
    return { kind: 'call', name, args, distinct, star }
  }

  #parseCase(): SqlExpression {
    this.#expectKeyword('CASE')
    const branches: { when: SqlExpression; then: SqlExpression }[] = []
    while (this.#matchKeyword('WHEN')) {
      const when = this.#parseExpression()
      this.#expectKeyword('THEN')
      const then = this.#parseExpression()
      branches.push({ when, then })
    }
    let elseExpression: SqlExpression | undefined
    if (this.#matchKeyword('ELSE')) elseExpression = this.#parseExpression()
    this.#expectKeyword('END')
    return {
      kind: 'case',
      branches,
      ...(elseExpression === undefined ? {} : { else: elseExpression }),
    }
  }

  #parseCast(): SqlExpression {
    this.#expectKeyword('CAST')
    this.#expectPunctuation('(')
    const operand = this.#parseExpression()
    this.#expectKeyword('AS')
    const targetType = this.#parseTypeName()
    this.#expectPunctuation(')')
    return { kind: 'cast', operand, targetType }
  }

  #parseTypeName(): string {
    const words: string[] = []
    for (;;) {
      const token = this.peek()
      const isWord =
        token.kind === 'identifier' ||
        (token.kind === 'keyword' && TYPE_WORD_KEYWORDS.has(token.upper))
      if (!isWord || words.length >= 4) break
      words.push(token.upper)
      this.#position += 1
    }
    if (words.length === 0) {
      const token = this.peek()
      throw new SqlParseError('expected a type name', token.start)
    }
    if (this.#matchPunctuation('(')) {
      for (;;) {
        const size = this.peek()
        if (size.kind !== 'number') {
          throw new SqlParseError('expected a numeric type parameter', size.start)
        }
        this.#position += 1
        if (!this.#matchPunctuation(',')) break
      }
      this.#expectPunctuation(')')
    }
    const base = words.join(' ')
    if (!ALLOWED_CAST_TYPES.has(base)) {
      const token = this.peek()
      throw new SqlParseError(`unsupported cast target type "${base}"`, token.start)
    }
    let result = base
    while (this.#matchPunctuation('[')) {
      this.#expectPunctuation(']')
      result += '[]'
    }
    return result
  }
}

export { SqlLexError }
