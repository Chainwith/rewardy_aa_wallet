// src/shared/io.ts
import * as fs from "fs";
import * as path from "path";

function bigintReplacer(_key: string, value: any) {
  // 모든 BigInt를 문자열로 저장
  return typeof value === "bigint" ? value.toString() : value;
}

export function saveJson(file: string, data: any) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, bigintReplacer, 2));
  console.log(`📝 saved: ${file}`);
}

export function loadJson<T = any>(file: string): T {
  const raw = fs.readFileSync(file, "utf-8");
  return JSON.parse(raw) as T; // 복원은 필요 위치에서 개별 변환
}

export function parseArgs() {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    const v = process.argv[i + 1];
    if (k?.startsWith("--")) { args[k.slice(2)] = v; i++; }
  }
  return args;
}
