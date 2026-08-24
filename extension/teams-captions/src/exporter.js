/** Xuất transcript ra text / markdown / json và tải về máy. */

function fmtClock(iso) {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function fmtStamp(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const Exporter = {
  txt(store) {
    const head = [
      `Transcript — ${store.title || 'Teams meeting'}`,
      `Bắt đầu: ${new Date(store.startedAt).toLocaleString()}`,
      `Số câu: ${store.entries.length}`,
      '',
      ''.padEnd(60, '─'),
      '',
    ].join('\n');

    const body = store.entries
      .map((e) => {
        const lines = [`[${fmtClock(e.at)}] ${e.name || '???'}`, `  ${e.ja}`];
        if (e.vi) lines.push(`  → ${e.vi}`);
        return lines.join('\n');
      })
      .join('\n\n');

    return `${head}${body}\n`;
  },

  md(store) {
    const head = [
      `# Transcript — ${store.title || 'Teams meeting'}`,
      '',
      `- **Bắt đầu:** ${new Date(store.startedAt).toLocaleString()}`,
      `- **Số câu:** ${store.entries.length}`,
      '',
      '---',
      '',
    ].join('\n');

    const body = store.entries
      .map((e) => {
        const lines = [`**${e.name || '???'}** · \`${fmtClock(e.at)}\``, '', e.ja];
        if (e.vi) lines.push('', `> ${e.vi}`);
        return lines.join('\n');
      })
      .join('\n\n');

    return `${head}${body}\n`;
  },

  json(store) {
    return JSON.stringify(
      {
        title: store.title,
        startedAt: store.startedAt,
        exportedAt: new Date().toISOString(),
        entries: store.entries.map(({ at, name, mri, ja, vi }) => ({
          at,
          name,
          mri,
          ja,
          vi,
        })),
      },
      null,
      2,
    );
  },

  /**
   * Tạo file và tải về. Trả về false nếu trình duyệt chặn — khi đó gọi
   * copyToClipboard làm phương án dự phòng.
   */
  download(store, kind) {
    const content = Exporter[kind](store);
    const ext = kind === 'json' ? 'json' : kind === 'md' ? 'md' : 'txt';
    const mime =
      kind === 'json' ? 'application/json' : 'text/plain;charset=utf-8';
    const name = `teams-transcript-${fmtStamp(store.startedAt)}.${ext}`;

    try {
      const url = URL.createObjectURL(new Blob([content], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return true;
    } catch {
      return false;
    }
  },

  async copyToClipboard(store, kind = 'txt') {
    await navigator.clipboard.writeText(Exporter[kind](store));
  },
};
