import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
