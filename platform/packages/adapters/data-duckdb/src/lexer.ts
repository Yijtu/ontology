/**
 * A deliberately small SQL lexer for the read-only query subset (SPEC C3).
 *
 * It exists because the sandbox must not be bypassable with comments, `;`, dollar
 * quoting or keyword splitting: the validator never inspects the raw string for
 * prefixes. Comments are dropped here, quoted strings/identifiers become single
 * tokens, and anything the subset does not model (dollar quotes, backticks,
 * `$`-parameters) is a hard lex error.
 *
 * Tokens carry their source offsets so the adapter can reconstruct the exact
 * statement text without trailing comments before appending a trusted `OFFSET`.
 */
export type SqlTokenKind =
  | 'identifier'
  | 'keyword'
  | 'number'
  | 'string'
  | 'parameter'
  | 'operator'
  | 'punctuation'
  | 'end'

export interface SqlToken {
  readonly kind: SqlTokenKind
  readonly text: string
  /** Upper-cased text, used for keyword comparison. */
  readonly upper: string
  readonly start: number
  readonly end: number
}

export class SqlLexError extends Error {
  readonly offset: number

  constructor(message: string, offset: number) {
    super(message)
    this.name = 'SqlLexError'
    this.offset = offset
  }
}

/**
 * Reserved words. The parser treats these as keywords everywhere; a registered
 * relation or column that collides with one must be quoted, which the parser
 * accepts as an `identifier` token.
 */
const KEYWORDS: ReadonlySet<string> = new Set([
  'ALL',
  'AND',
  'ANY',
  'AS',
  'ASC',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'CROSS',
  'DATE',
  'DESC',
  'DISTINCT',
  'ELSE',
  'END',
  'EXCEPT',
  'EXISTS',
  'FALSE',
  'FETCH',
  'FIRST',
  'FULL',
  'FROM',
  'GROUP',
  'HAVING',
  'ILIKE',
  'IN',
  'INNER',
  'INTERSECT',
  'INTERVAL',
  'INTO',
  'IS',
  'JOIN',
  'LAST',
  'LEFT',
  'LIKE',
  'LIMIT',
  'NATURAL',
  'NOT',
  'NULL',
  'NULLS',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'QUALIFY',
  'RECURSIVE',
  'RIGHT',
  'SELECT',
  'SIMILAR',
  'THEN',
  'TIME',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'TO',
  'TRUE',
  'UNION',
  'USING',
  'WHEN',
  'WHERE',
  'WINDOW',
  'WITH',
])

function isIdentifierStart(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_'
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || (char >= '0' && char <= '9')
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}

const MULTI_CHAR_OPERATORS: readonly string[] = ['->>', '->', '::', '||', '<>', '!=', '<=', '>=']

const SINGLE_CHAR_TOKENS: ReadonlySet<string> = new Set([
  '=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '(',
  ')',
  ',',
  '.',
  ';',
  '[',
  ']',
])

/**
 * Split `sql` into tokens. Throws `SqlLexError` on an unterminated literal/comment or
 * any character the subset does not model. A single `end` token always terminates the
 * stream so the parser never has to handle a missing token.
 */
export function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let index = 0
  while (index < sql.length) {
    const char = sql[index] ?? ''
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f') {
      index += 1
      continue
    }
    if (char === '-' && sql[index + 1] === '-') {
      index += 2
      while (index < sql.length && sql[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2)
      if (close === -1) throw new SqlLexError('unterminated block comment', index)
      index = close + 2
      continue
    }
    if (char === "'") {
      const start = index
      index += 1
      let text = ''
      for (;;) {
        if (index >= sql.length) throw new SqlLexError('unterminated string literal', start)
        const current = sql[index] ?? ''
        if (current === "'") {
          if (sql[index + 1] === "'") {
            text += "'"
            index += 2
            continue
          }
          index += 1
          break
        }
        text += current
        index += 1
      }
      tokens.push({ kind: 'string', text, upper: text.toUpperCase(), start, end: index })
      continue
    }
    if (char === '"') {
      const start = index
      index += 1
      let text = ''
      for (;;) {
        if (index >= sql.length) throw new SqlLexError('unterminated quoted identifier', start)
        const current = sql[index] ?? ''
        if (current === '"') {
          if (sql[index + 1] === '"') {
            text += '"'
            index += 2
            continue
          }
          index += 1
          break
        }
        text += current
        index += 1
      }
      tokens.push({ kind: 'identifier', text, upper: text.toUpperCase(), start, end: index })
      continue
    }
    if (char === '`' || char === '$') {
      throw new SqlLexError(
        `unsupported character "${char}"; only '?' positional parameters are accepted`,
        index,
      )
    }
    if (isIdentifierStart(char)) {
      const start = index
      index += 1
      while (index < sql.length && isIdentifierPart(sql[index] ?? '')) index += 1
      const text = sql.slice(start, index)
      const upper = text.toUpperCase()
      tokens.push({
        kind: KEYWORDS.has(upper) ? 'keyword' : 'identifier',
        text,
        upper,
        start,
        end: index,
      })
      continue
    }
    if (isDigit(char) || (char === '.' && isDigit(sql[index + 1] ?? ''))) {
      const start = index
      while (index < sql.length && isDigit(sql[index] ?? '')) index += 1
      if (sql[index] === '.') {
        index += 1
        while (index < sql.length && isDigit(sql[index] ?? '')) index += 1
      }
      if (sql[index] === 'e' || sql[index] === 'E') {
        const marker = index
        index += 1
        if (sql[index] === '+' || sql[index] === '-') index += 1
        if (isDigit(sql[index] ?? '')) {
          while (index < sql.length && isDigit(sql[index] ?? '')) index += 1
        } else {
          index = marker
        }
      }
      const text = sql.slice(start, index)
      tokens.push({ kind: 'number', text, upper: text, start, end: index })
      continue
    }
    if (char === '?') {
      tokens.push({ kind: 'parameter', text: '?', upper: '?', start: index, end: index + 1 })
      index += 1
      continue
    }
    const three = sql.slice(index, index + 3)
    const two = sql.slice(index, index + 2)
    if (MULTI_CHAR_OPERATORS.includes(three)) {
      tokens.push({ kind: 'operator', text: three, upper: three, start: index, end: index + 3 })
      index += 3
      continue
    }
    if (MULTI_CHAR_OPERATORS.includes(two)) {
      tokens.push({ kind: 'operator', text: two, upper: two, start: index, end: index + 2 })
      index += 2
      continue
    }
    if (SINGLE_CHAR_TOKENS.has(char)) {
      tokens.push({ kind: 'punctuation', text: char, upper: char, start: index, end: index + 1 })
      index += 1
      continue
    }
    throw new SqlLexError(`unsupported character "${char}"`, index)
  }
  tokens.push({ kind: 'end', text: '', upper: '', start: sql.length, end: sql.length })
  return tokens
}

/** True when the token is the given keyword. */
export function isKeyword(token: SqlToken, keyword: string): boolean {
  return token.kind === 'keyword' && token.upper === keyword
}
