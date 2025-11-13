export function parseArgs() {
  // ultra-light arg parser:  --key value  형식
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    const v = process.argv[i + 1];
    if (k?.startsWith("--")) {
      args[k.slice(2)] = v;
      i++;
    }
  }
  return args;
}
