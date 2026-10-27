const wave = "                           .:=+*********+=:.\n                       .:=******************+-\n                     :=************************-\n                   :+***************************+.\n                 .+*******************************\n                -**********************=:.   ..:=*=\n               =*********************-            :\n              =*********************-\n             =**********************.\n            -***********************-\n           .*************************-\n           ****************************-.\n          +******************************+-.\n        .+**********************************=.\n       -*********************+=++=+***********=.\n     :+*********************+%#=-+%#+***********-\n#%%%%%%%%%%%%%%%%%%%%%%%%%%%%+    :%%%%%%%%%%%%%%%%#\n:---------------------------%%-..:+%=--------------:\n                            .=#%%%#-";
const compactWave = "                    :-+********+=:.\n                 :=****************=.\n               -*********************-\n             -******************++++**=\n            +****************-.      .-\n          .*****************.\n          ******************\n         +******************=\n        =*********************-.\n       -************************+-\n     .+****************+==+********=.\n.:::-+*++++++++++++++=#=--++++++++**+::.\n+####################%#   -%###########+\n                     .+#++#-";
interface TerminalDestination { isTTY?: boolean; columns?: number }
type Environment = Readonly<Record<string, string | undefined>>;

/** The destination and explicit opt-outs take precedence over FORCE_COLOR. */
export function terminalColors(stream: TerminalDestination, env: Environment): boolean {
  return !!stream.isTTY && env.TERM !== 'dumb' && !env.CI && !env.NO_COLOR && env.FORCE_COLOR !== '0';
}

/** Decorative text is for explicitly requested root help on an ordinary terminal. */
export function helpBrand(stream: TerminalDestination, env: Environment): string {
  if (!stream.isTTY || env.TERM === 'dumb' || env.CI) return '';
  const columns = stream.columns ?? 0;
  const art = columns >= 56 ? wave : columns >= 44 ? compactWave : '';
  const color = terminalColors(stream, env);
  const mark = art ? art.split('\n').map(line => `  ${line}`).join('\n') + '\n\n' : '';
  const name = color ? '\x1b[1mCommitTide\x1b[22m' : 'CommitTide';
  const tagline = 'Good commits. Clear history.';
  return (mark && color ? `\x1b[36m${mark}\x1b[39m` : mark)
    + name + '\n' + (columns >= tagline.length ? tagline + '\n' : '');
}
