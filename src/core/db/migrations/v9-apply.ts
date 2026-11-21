// v8 → v9 的数据回填：模板默认标签 + 已建条目补齐。
//
// DDL 只加 `templates.tags` 列；这里做两件事：
//   1. 每个非空白模板默认带「模板 id + 标题」两个 tag（用户后面可用 template update --tags 改）；
//   2. 已存在且出身模板的条目合并模板 tags——「从模板创建的条目自带 tag」对存量也成立。
// 只增不删：条目原有 tags 一律保留。
import type { Conn, Row } from '../driver.ts';

const BLANK_TEMPLATE_ID = '__blank__';

function parseTags(raw: unknown): string[] {
  try {
    const x = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(x) ? x.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function mergeTags(...lists: string[][]): string[] {
  const out: string[] = [];
  for (const list of lists) for (const t of list) if (t && !out.includes(t)) out.push(t);
  return out;
}

export function applyV9(db: Conn): void {
  const templates = db.all('SELECT id, title, tags FROM templates') as Row[];
  const templateTags = new Map<string, string[]>();
  for (const t of templates) {
    const id = String(t.id ?? '');
    const title = String(t.title ?? '').trim();
    const tags = id === BLANK_TEMPLATE_ID ? [] : mergeTags(parseTags(t.tags), [id], title && title !== id ? [title] : []);
    templateTags.set(id, tags);
    db.run('UPDATE templates SET tags = :tags WHERE id = :id', { id, tags: JSON.stringify(tags) });
  }

  const entries = db.all('SELECT id, template_id, tags FROM entries') as Row[];
  for (const e of entries) {
    const templateId = String(e.template_id ?? '');
    const inherited = templateTags.get(templateId) || [];
    if (!inherited.length) continue;
    const tags = mergeTags(parseTags(e.tags), inherited);
    db.run('UPDATE entries SET tags = :tags WHERE id = :id', { id: String(e.id), tags: JSON.stringify(tags) });
  }
}
