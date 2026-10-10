// 静态仓库规则：浏览器运行无法发现未走到的词条或另一语言漏掉的插值。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { catalogs, parameterTypes, networkMessageCodes } from "../src/catalog.ts";

const keys = (value) => Object.keys(value).sort();
const placeholders = (text) =>
  [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]))].sort();
assert.deepEqual(keys(catalogs["zh-CN"]), keys(catalogs.en), "两种语言的词条必须一致");
assert.deepEqual(keys(catalogs.en), keys(parameterTypes), "每个词条必须声明插值参数类型");
for (const code of keys(parameterTypes)) {
  const schema = parameterTypes[code];
  assert(
    Object.values(schema).every((type) => type === "string" || type === "number"),
    `${code}: 参数只能是 string/number`,
  );
  for (const locale of ["zh-CN", "en"]) {
    assert.equal(typeof catalogs[locale][code], "string", `${locale}/${code}: 文案必须是字符串`);
    assert(catalogs[locale][code].trim(), `${locale}/${code}: 文案不能为空`);
    assert.deepEqual(
      placeholders(catalogs[locale][code]),
      keys(schema),
      `${locale}/${code}: 插值和参数声明不一致`,
    );
  }
}
assert.equal(new Set(networkMessageCodes).size, networkMessageCodes.length, "网络键不能重复");
// 接口表是跨语言共同契约；文档或实现单边加键必须令现有 client build 失败。
for (const relative of ["../../docs/interfaces.md", "../../docs/zh-CN/interfaces.md"]) {
  const text = await readFile(new URL(relative, import.meta.url), "utf8");
  const schemas = {};
  for (const line of text.split("\n")) {
    if (!/^\| `(?:notice|error|task|report)\./.test(line)) continue;
    const [, codes, parameters] = line.split("|");
    const schema = Object.fromEntries(
      [...parameters.matchAll(/`(\w+)`[:：]\s*(string|number)/g)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    for (const match of codes.matchAll(/`([^`]+)`/g)) {
      const grouped = /^(.*)\.\{([^}]+)\}$/.exec(match[1]);
      const expanded = grouped
        ? grouped[2].split(",").map((suffix) => `${grouped[1]}.${suffix}`)
        : [match[1]];
      for (const code of expanded) schemas[code] = schema;
    }
  }
  assert.deepEqual(
    keys(schemas),
    [...networkMessageCodes].sort(),
    `${relative}: 网络键和接口表不一致`,
  );
  for (const code of keys(schemas))
    assert.deepEqual(
      parameterTypes[code],
      schemas[code],
      `${relative}/${code}: 参数类型和接口表不一致`,
    );
}
for (const code of networkMessageCodes)
  assert(Object.hasOwn(parameterTypes, code), `${code}: 网络键缺少词条`);
console.log(
  `Catalogs checked: ${keys(parameterTypes).length} bilingual keys, ${networkMessageCodes.length} network keys.`,
);
