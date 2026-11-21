// Tiny ANSI helpers — no dependency on purpose. Honors NO_COLOR and non-TTY output.
const colorOn = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string): string =>
  colorOn ? `\x1b[${code}m${s}\x1b[0m` : s;

export const dim = wrap('2');
export const bold = wrap('1');
export const cyan = wrap('36');
export const green = wrap('32');
export const red = wrap('31');
export const magenta = wrap('35');

export const banner = (model: string): string =>
  `${bold(magenta('🐙 polvo'))} ${dim('v0.0.1')}  ${dim('· model:')} ${model}\n` +
  `${dim('type a message · /exit to quit')}\n\n`;

export const youPrompt = `${cyan('you')} ${dim('›')} `;
export const assistantLabel = `${green('polvo')} ${dim('›')} `;
export const errorLine = (msg: string): string =>
  `${red('error')} ${dim('›')} ${msg}`;
