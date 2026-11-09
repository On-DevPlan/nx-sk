// 表格的写入封装：归一之后，敏感**列**与顶层敏感字段同一条边界——密文落盘。
//
// 与 entrylist 的一处改进：打码占位先按**同一行**找原密文，找不到再按**整列**找。
// 表格是能上下拖动排序的，只按行号对齐会在拖过一次之后把「密码」认到别人头上——
// 那种错不报错、只是悄悄换了一个人的密码，比直接报错难查得多。
import { badInput } from '../../errors.ts';
import { decryptValue, encryptValue, isCipherBlob, maskValue } from '../../crypto.ts';
import { resolveVaultKey } from '../../vault.ts';
import { normalizeTable } from '../behaviors/table.ts';
import { looksMasked } from './common.ts';
import type { SealContext, SealHook } from '../../../shared/fields/types.ts';

export const sealTable: SealHook = async ({ def, raw, current }: SealContext) => {
  // 注意：这里**不走** coerce 的「必须是行数组」前置校验——面板保存的形状是
  // `{columns, rows}` 文档、`{}` 表示清空；那条校验只属于 CLI `--set` 入口。
  const doc = normalizeTable(def, raw);
  if (!doc) return null; // 空表：清空这个字段
  const cols = doc.columns.filter((c: any) => c.sensitive && !c.formula);
  if (!cols.length) return doc;
  const curDoc = Array.isArray(current) ? { rows: current } : (current && typeof current === 'object' ? current : {});
  const cur = Array.isArray(curDoc.rows) ? curDoc.rows : [];
  const plainByBlob = new Map<any, string | null>();

  const decryptBlob = async (blob: any) => {
    if (!isCipherBlob(blob)) return null;
    if (plainByBlob.has(blob)) return plainByBlob.get(blob);
    let plain: string | null = null;
    try {
      const { key } = await resolveVaultKey();
      plain = decryptValue(key, blob);
    } catch { /* 解不开（换过密钥）就当作对不上 */ }
    plainByBlob.set(blob, plain);
    return plain;
  };

  const rows: any[] = [];
  for (let i = 0; i < doc.rows.length; i += 1) {
    const row = { ...doc.rows[i] };
    for (const c of cols) {
      const text = row[c.key];
      if (text === undefined || text === null) continue;
      if (typeof text === 'object') continue; // 已是密文对象（导入/还原）
      const s = String(text);
      if (!looksMasked(s)) {
        const { key } = await resolveVaultKey();
        row[c.key] = encryptValue(key, s);
        continue;
      }
      // 打码占位 = 「这一格没改」。不能只按行号对齐：表格能上下拖动排序，
      // 拖过一次就会把密码认到别人头上。
      //   先按**打码值**认（能唯一命中就正确，与行序无关）；
      //   认不出来（这一列有多个格子打码后长得一样，短密码全是星）时退回**行号**兜底——
      //   这就是 entrylist 一直以来的行为，也是这条路唯一的已知限制：
      //   打码状态下拖动行，且两格打码值相同，就无法区分谁是谁。
      const cands: any[] = [];
      for (const blob of [cur[i]?.[c.key], ...cur.map((r: any) => r?.[c.key])]) {
        if (!blob || !isCipherBlob(blob) || cands.includes(blob)) continue;
        const plain = await decryptBlob(blob);
        if (plain !== null && maskValue(plain) === s) cands.push(blob);
      }
      if (cands.length === 1) { row[c.key] = cands[0]; continue; }
      // 兜底：同一行原来的密文。没拖动过时这是对的；拖动过且打码值相同则无法区分
      //（打码值本身不携带身份信息，短密码全是星）——这是这条路上唯一的已知限制。
      const here = cur[i]?.[c.key];
      if (here && isCipherBlob(here)) {
        const plain = await decryptBlob(here);
        if (plain !== null && maskValue(plain) === s) { row[c.key] = here; continue; }
      }
      throw badInput(`字段「${def.label}」第 ${i + 1} 行「${c.label}」收到的是打码占位而非明文。`
        + '给完整值，或把这一格清掉重填（取消「打码显示」后保存也可以）。');
    }
    rows.push(row);
  }
  return { ...doc, rows };
};
