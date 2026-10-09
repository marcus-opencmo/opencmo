/**
 * Biểu thức toán nhỏ cho visual: đồ thị y = f(x), mặt z = f(x, y). Chuỗi do
 * agent/người dùng gõ nên đọc bằng parser tự viết — KHÔNG `eval`/`Function`:
 * document chạy lại trên server lúc export.
 */

export type Expr = (scope: Record<string, number>) => number;

const FUNCTIONS: Record<string, (value: number) => number> = {
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	exp: Math.exp,
	log: Math.log,
	ln: Math.log,
	sqrt: Math.sqrt,
	abs: Math.abs,
	floor: Math.floor,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export class ExprError extends Error {}

/**
 * Đọc biểu thức theo các biến `variables` (một chữ cái: x, y, t…): số, biến,
 * + − * / ^, ngoặc, hàm sin/cos/tan/exp/log/ln/sqrt/abs/floor, hằng pi/e, nhân
 * ngầm ("2x", "3(x+1)", "x sin(x)", "xy").
 */
export function parseExpr(source: string, variables: readonly string[] = ['x']): Expr {
	const text = source.replace(/\s+/g, '');
	if (!text || text.length > 200) throw new ExprError(`Write a formula in ${variables.join(', ')}, like x^2 or sin(x).`);
	let i = 0;
	const peek = () => text[i];
	const fail = (message: string): never => {
		throw new ExprError(message);
	};

	// sum := product (('+'|'-') product)*
	const sum = (): Expr => {
		let left = product();
		while (peek() === '+' || peek() === '-') {
			const op = text[i++];
			const right = product();
			const l = left;
			left = op === '+' ? (s) => l(s) + right(s) : (s) => l(s) - right(s);
		}
		return left;
	};
	// product := unary (('*'|'/'|ngầm) unary)*
	const product = (): Expr => {
		let left = unary();
		for (;;) {
			const c = peek();
			if (c === '*' || c === '/') {
				i++;
				const right = unary();
				const l = left;
				left = c === '*' ? (s) => l(s) * right(s) : (s) => l(s) / right(s);
			} else if (c !== undefined && /[0-9.a-z(]/i.test(c)) {
				const right = unary();
				const l = left;
				left = (s) => l(s) * right(s);
			} else return left;
		}
	};
	// unary := '-' unary | power
	const unary = (): Expr => {
		if (peek() === '-') {
			i++;
			const inner = unary();
			return (s) => -inner(s);
		}
		if (peek() === '+') {
			i++;
			return unary();
		}
		return power();
	};
	// power := atom ('^' unary)?  (phải kết hợp: 2^3^2 = 2^9)
	const power = (): Expr => {
		const base = atom();
		if (peek() !== '^') return base;
		i++;
		const exponent = unary();
		return (s) => Math.pow(base(s), exponent(s));
	};
	const atom = (): Expr => {
		const c = peek();
		if (c === undefined) return fail('The formula ends too early.');
		if (c === '(') {
			i++;
			const inner = sum();
			if (peek() !== ')') fail('A bracket is not closed.');
			i++;
			return inner;
		}
		const number = /^(?:\d+\.?\d*|\.\d+)/.exec(text.slice(i));
		if (number) {
			i += number[0].length;
			const value = Number(number[0]);
			return () => value;
		}
		const word = /^[a-z]+/i.exec(text.slice(i));
		if (word) {
			const name = word[0].toLowerCase();
			// Hàm trước biến: với biến t, "tan(" vẫn là tan. Tên hàm phải có ngoặc
			// ngay sau ("sinx" không phải sin(x)).
			const fn = Object.keys(FUNCTIONS).find((key) => name.startsWith(key) && text[i + key.length] === '(');
			if (fn) {
				i += fn.length;
				const arg = atom();
				const f = FUNCTIONS[fn]!;
				return (s) => f(arg(s));
			}
			// "xsin(x)" (khoảng trắng đã bỏ) = x · sin(x): biến một chữ luôn đứng một mình.
			const variable = variables.find((v) => name.startsWith(v));
			if (variable) {
				i += 1;
				return (scope) => scope[variable] ?? NaN;
			}
			const constant = Object.keys(CONSTANTS).find((key) => name.startsWith(key));
			if (constant) {
				i += constant.length;
				const value = CONSTANTS[constant]!;
				return () => value;
			}
			return fail(`Unknown name "${word[0]}" — use ${variables.join(', ')}, pi, e and functions like sin(x).`);
		}
		return fail(`Unexpected "${c}" in the formula.`);
	};

	const expr = sum();
	if (i < text.length) fail(`Unexpected "${text[i]}" in the formula.`);
	return expr;
}

