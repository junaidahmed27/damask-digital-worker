/**
 * The formula evaluator. Excel like, and deliberately small: a tokenizer, a
 * recursive descent parser and an interpreter over cell references. There is no
 * eval, no host access and no way to reach a connector from a formula, because a
 * formula is a derived value and nothing else.
 *
 *   =ALL_VERIFIED(children)
 *   =AS_OF(covenant_tests.headroom, last_quarter)
 *   =SUM(rows.amount)
 *   =IF(confidence < 0.6, "escalate", "auto")
 *   =DAYS_SINCE(last_reply) > 7
 *
 * The same evaluator reads a rule's condition, so a rule a person writes and a
 * formula a person writes are the same language.
 */

export type FormulaValue = string | number | boolean | null | FormulaValue[];

export type FormulaScope = {
  /** A column's value on the row being computed. */
  cell(column: string): FormulaValue;
  /** A column's values across every row of the sheet. */
  column(name: string): FormulaValue[];
  /** The child rows of this row, as their states. */
  children(): { id: string; state: string }[];
  /** A column's value on this row as it stood at an instant. */
  asOf(column: string, when: Date): FormulaValue;
  /** Named instants a formula may refer to. */
  instant(name: string): Date | undefined;
  now(): Date;
};

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaError";
  }
}

export function evaluateFormula(source: string, scope: FormulaScope): FormulaValue {
  const text = source.trim().replace(/^=/, "");
  if (!text) return null;
  const tokens = tokenize(text);
  const parser = new Parser(tokens);
  const node = parser.parseExpression();
  parser.expectEnd();
  return evaluate(node, scope);
}

/* ---------------------------------------------------------------- tokens */

type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string }
  | { kind: "punct"; value: "(" | ")" | "," };

const OPERATORS = ["<=", ">=", "==", "!=", "<", ">", "+", "-", "*", "/"];

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(" || char === ")" || char === ",") {
      tokens.push({ kind: "punct", value: char });
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = text.indexOf(char, index + 1);
      if (end < 0) throw new FormulaError("a string in this formula is not closed");
      tokens.push({ kind: "string", value: text.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(text[index + 1] ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+/.exec(text.slice(index));
      if (!match) throw new FormulaError("that number cannot be read");
      tokens.push({ kind: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(index));
      if (!match) throw new FormulaError("that name cannot be read");
      tokens.push({ kind: "name", value: match[0] });
      index += match[0].length;
      continue;
    }
    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index));
    if (operator) {
      tokens.push({ kind: "op", value: operator });
      index += operator.length;
      continue;
    }
    throw new FormulaError(`${char} has no meaning in a formula`);
  }

  return tokens;
}

/* ---------------------------------------------------------------- parse */

type Node =
  | { kind: "literal"; value: FormulaValue }
  | { kind: "reference"; path: string }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "unary"; op: string; operand: Node };

class Parser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  parseExpression(): Node {
    return this.parseComparison();
  }

  private parseComparison(): Node {
    let left = this.parseAdditive();
    while (this.matchOp("<", ">", "<=", ">=", "==", "!=")) {
      const op = (this.previous() as { value: string }).value;
      left = { kind: "binary", op, left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    while (this.matchOp("+", "-")) {
      const op = (this.previous() as { value: string }).value;
      left = { kind: "binary", op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    while (this.matchOp("*", "/")) {
      const op = (this.previous() as { value: string }).value;
      left = { kind: "binary", op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.matchOp("-")) return { kind: "unary", op: "-", operand: this.parseUnary() };
    if (this.matchName("NOT")) return { kind: "unary", op: "NOT", operand: this.parseUnary() };
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const token = this.tokens[this.position];
    if (!token) throw new FormulaError("this formula ends too early");

    if (token.kind === "number" || token.kind === "string") {
      this.position += 1;
      return { kind: "literal", value: token.value };
    }

    if (token.kind === "punct" && token.value === "(") {
      this.position += 1;
      const inner = this.parseExpression();
      this.expect(")");
      return inner;
    }

    if (token.kind === "name") {
      this.position += 1;
      const next = this.tokens[this.position];
      if (next && next.kind === "punct" && next.value === "(") {
        this.position += 1;
        const args: Node[] = [];
        if (!this.check(")")) {
          do {
            args.push(this.parseExpression());
          } while (this.matchPunct(","));
        }
        this.expect(")");
        return { kind: "call", name: token.value.toUpperCase(), args };
      }
      if (token.value === "true" || token.value === "TRUE") return { kind: "literal", value: true };
      if (token.value === "false" || token.value === "FALSE") return { kind: "literal", value: false };
      return { kind: "reference", path: token.value };
    }

    throw new FormulaError(`${JSON.stringify(token)} cannot start a value`);
  }

  expectEnd(): void {
    if (this.position < this.tokens.length) throw new FormulaError("there is more in this formula than it can read");
  }

  private expect(value: string): void {
    if (!this.matchPunct(value)) throw new FormulaError(`expected ${value}`);
  }

  private check(value: string): boolean {
    const token = this.tokens[this.position];
    return Boolean(token && token.kind === "punct" && token.value === value);
  }

  private matchPunct(value: string): boolean {
    if (this.check(value)) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private matchOp(...values: string[]): boolean {
    const token = this.tokens[this.position];
    if (token && token.kind === "op" && values.includes(token.value)) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private matchName(value: string): boolean {
    const token = this.tokens[this.position];
    if (token && token.kind === "name" && token.value.toUpperCase() === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private previous(): Token | undefined {
    return this.tokens[this.position - 1];
  }
}

/* ---------------------------------------------------------------- evaluate */

function evaluate(node: Node, scope: FormulaScope): FormulaValue {
  switch (node.kind) {
    case "literal":
      return node.value;

    case "reference":
      return resolveReference(node.path, scope);

    case "unary": {
      const value = evaluate(node.operand, scope);
      if (node.op === "-") return -toNumber(value);
      return !truthy(value);
    }

    case "binary": {
      const left = evaluate(node.left, scope);
      const right = evaluate(node.right, scope);
      switch (node.op) {
        case "+":
          return typeof left === "string" || typeof right === "string"
            ? `${stringify(left)}${stringify(right)}`
            : toNumber(left) + toNumber(right);
        case "-":
          return toNumber(left) - toNumber(right);
        case "*":
          return toNumber(left) * toNumber(right);
        case "/": {
          const divisor = toNumber(right);
          return divisor === 0 ? null : toNumber(left) / divisor;
        }
        case "<":
          return toNumber(left) < toNumber(right);
        case ">":
          return toNumber(left) > toNumber(right);
        case "<=":
          return toNumber(left) <= toNumber(right);
        case ">=":
          return toNumber(left) >= toNumber(right);
        case "==":
          return stringify(left) === stringify(right);
        case "!=":
          return stringify(left) !== stringify(right);
        default:
          throw new FormulaError(`${node.op} is not an operator here`);
      }
    }

    case "call":
      return call(node, scope);
  }
}

function call(node: { name: string; args: Node[] }, scope: FormulaScope): FormulaValue {
  const { name, args } = node;

  switch (name) {
    case "ALL_VERIFIED": {
      const first = args[0];
      if (first && first.kind === "reference" && first.path === "children") {
        const children = scope.children();
        return children.length > 0 && children.every((c) => c.state === "verified" || c.state === "done");
      }
      const values = flatten(args.map((arg) => evaluate(arg, scope)));
      return values.length > 0 && values.every((v) => v === "verified" || v === "done" || v === true);
    }

    case "AS_OF": {
      const reference = args[0];
      if (!reference || reference.kind !== "reference") throw new FormulaError("AS_OF needs a column reference");
      const whenNode = args[1];
      const when = whenNode ? instantOf(whenNode, scope) : scope.now();
      return scope.asOf(reference.path, when);
    }

    case "SUM": {
      const values = flatten(args.map((arg) => evaluate(arg, scope)));
      return values.reduce<number>((total, value) => total + toNumber(value), 0);
    }

    case "DAYS_SINCE": {
      const reference = args[0];
      if (!reference) throw new FormulaError("DAYS_SINCE needs a column reference");
      const value = evaluate(reference, scope);
      if (typeof value !== "string" && typeof value !== "number") return null;
      const then = new Date(value);
      if (Number.isNaN(then.getTime())) return null;
      return Math.floor((scope.now().getTime() - then.getTime()) / 86_400_000);
    }

    case "COUNT":
      return flatten(args.map((arg) => evaluate(arg, scope))).filter((v) => v !== null && v !== "").length;

    case "IF": {
      const [condition, whenTrue, whenFalse] = args;
      if (!condition) throw new FormulaError("IF needs a condition");
      return truthy(evaluate(condition, scope))
        ? (whenTrue ? evaluate(whenTrue, scope) : true)
        : (whenFalse ? evaluate(whenFalse, scope) : false);
    }

    case "AND":
      return args.every((arg) => truthy(evaluate(arg, scope)));

    case "OR":
      return args.some((arg) => truthy(evaluate(arg, scope)));

    case "MIN":
      return Math.min(...flatten(args.map((arg) => evaluate(arg, scope))).map(toNumber));

    case "MAX":
      return Math.max(...flatten(args.map((arg) => evaluate(arg, scope))).map(toNumber));

    default:
      throw new FormulaError(`${name} is not a function a formula may call`);
  }
}

function resolveReference(path: string, scope: FormulaScope): FormulaValue {
  if (path === "today" || path === "now") return scope.now().toISOString();
  if (path === "children") return scope.children().map((c) => c.state);
  if (path.startsWith("rows.")) return scope.column(path.slice("rows.".length));
  return scope.cell(path);
}

function instantOf(node: Node, scope: FormulaScope): Date {
  if (node.kind === "reference") {
    const named = scope.instant(node.path);
    if (named) return named;
  }
  const value = evaluate(node, scope);
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return scope.now();
}

function flatten(values: FormulaValue[]): FormulaValue[] {
  return values.flatMap((value) => (Array.isArray(value) ? flatten(value) : [value]));
}

function toNumber(value: FormulaValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function truthy(value: FormulaValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value !== "" && value !== "false";
  return Boolean(value);
}

function stringify(value: FormulaValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.map(stringify).join(",");
  return String(value);
}

/** The named instants a formula may use. */
export function namedInstants(now: Date): Record<string, Date> {
  const quarterStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
  return {
    today: now,
    now,
    yesterday: new Date(now.getTime() - 86_400_000),
    last_week: new Date(now.getTime() - 7 * 86_400_000),
    last_month: new Date(now.getTime() - 30 * 86_400_000),
    last_quarter: new Date(quarterStart.getTime() - 1),
    last_year: new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate())),
  };
}
