/*
 * MMLヘルプ索引 (MML.HelpIndex)
 *
 * MML本文そのものをヘルプの正典として扱い、";@help" タグの付いたコメントブロックを
 * 「コマンド解説+実演スニペット」として抜き出す。ヘルプを別ファイル(JSON/Markdown)で
 * 二重管理すると、解説だけが実装から取り残されて腐る(実例: @Nの「16サンプル固定」記述が
 * 可変長化から1年近く残っていた)。タグは全て ";" コメントなので、コンパイル・ブラウザ再生・
 * NSF書き出しには一切影響しない。
 *
 * 【書式】
 *   ;@help <コマンド…> :: <見出し> :: <カテゴリ>    ← この1行だけが必須の追加
 *   ;@help.en <English title> :: <English category> (任意)
 *   (区切りが "|" でなく "::" なのは、"|"自体が繰り返し脱出のMMLコマンドで衝突するため)
 *   ; 日本語の説明本文(タグでない普通のコメント行がそのまま本文になる)
 *   ;@en English body line                          (任意、無ければ日本語のみ)
 *   @v0 = { ... }                                   ← 実演スニペット(定義行も含めてよい)
 *   A @v0 c1
 *
 *   1エントリは「次の ;@help」または「次のセクション見出し(; ====…)」または本文末尾まで。
 *   途中の空行・タグ無しコメント行はブロックを終わらせない(既存サンプルMMLの見た目のまま
 *   タグを1行足すだけで移行できるようにするため)。
 *
 * 【再生】playableSource() が、そのエントリだけを鳴らせる自己完結MMLを組み立てる:
 *   #EX-*宣言 + 曲中の全定義行 + 使用チャンネルのセットアップ行(t/l/o/v/@) + スニペット。
 *   定義行を全部載せるのは、定義がどこに書いてあっても解決させるため(コンパイルは軽い)。
 *
 * MML.HelpIndex.parse(source)            -> { entries, chapters, errors }
 * MML.HelpIndex.playableSource(src, e)   -> MML文字列
 * MML.HelpIndex.lint(source, compileFn)  -> [{ level, message, lineNo }]
 */
(function (global) {
  'use strict';
  const MML = global.MML = global.MML || {};
  const HelpIndex = MML.HelpIndex = MML.HelpIndex || {};
  // 表示文言の翻訳 (src/i18n/i18n.js)。ヘッドレス(help-lint.js)など MML.I18n が無い環境では素通し
  const T = (key, params) => (MML.I18n
    ? MML.I18n.t(key, params)
    : String(key).replace(/{(w+)}/g, (m, n) => (params && params[n] !== undefined ? params[n] : m)));

  const HELP_TAG_RE = /^;@help\s+(.*)$/;
  const HELP_EN_TAG_RE = /^;@help\.en\s+(.*)$/;
  const BODY_EN_RE = /^;@en\s?(.*)$/;
  const SECTION_RULE_RE = /^;\s*={5,}\s*$/;      // "; ================" の罫線
  const COMMENT_RE = /^;/;
  // 定義行(@v0 = { … } / $z c8d8e8g8)。"{"が閉じるまで複数行にまたがる場合がある
  const DEF_START_RE = /^@[A-Za-z]*\d*\s*=\s*\{/;
  const MACRO_DEF_RE = /^\$(.)\s+(.*)$/;
  const CHANNEL_LINE_RE = /^([A-Za-z])\s+(.*)$/;
  // セットアップ行の判定: そのチャンネルの冒頭で t/l/o/v を設定している行
  const SETUP_HINT_RE = /\bt\d/;

  function splitLines(source) {
    return String(source == null ? '' : source).split('\n').map(s => s.replace(/\r$/, ''));
  }

  // "コマンド… :: 見出し :: カテゴリ" を分解する
  function parseTagArgs(rest) {
    const parts = rest.split('::').map(s => s.trim());
    const commands = (parts[0] || '').split(/\s+/).filter(Boolean);
    // 第4フィールドは任意のフラグ。今のところ「解説のみ」(鳴らして見せられないコマンド)だけ
    const flags = (parts[3] || '').split(/[\s,]+/).filter(Boolean);
    return {
      commands, title: parts[1] || '', category: parts[2] || '',
      docOnly: flags.some(f => f === '解説のみ' || f.toLowerCase() === 'nodemo')
    };
  }

  /*
   * 直近のセクション見出しを覚えるための小さな状態機械。
   * "; ====" 罫線に挟まれた ";" 行を見出し(章)とみなす(既存サンプルMMLの書き方そのまま)。
   */
  function makeChapterTracker() {
    let pendingRule = false;
    let chapter = '';
    let collecting = null;
    return {
      feed(line) {
        if (SECTION_RULE_RE.test(line)) {
          if (collecting) {            // 見出しブロックの終わり
            chapter = collecting.join(' ').trim();
            collecting = null;
            pendingRule = false;
          } else {
            pendingRule = true;
            collecting = [];
          }
          return true;                 // 罫線自体はエントリの区切り
        }
        if (collecting && COMMENT_RE.test(line)) {
          collecting.push(line.replace(/^;\s?/, '').trim());
          return true;
        }
        if (collecting) { collecting = null; pendingRule = false; }
        return false;
      },
      get current() { return chapter; },
      get inHeading() { return collecting !== null || pendingRule; }
    };
  }

  HelpIndex.parse = function (source) {
    const lines = splitLines(source);
    const entries = [];
    const errors = [];
    const chapters = [];
    const tracker = makeChapterTracker();
    let entry = null;

    const closeEntry = () => {
      if (!entry) return;
      entry.body = entry.bodyLines.join('\n').trim();
      entry.bodyEn = entry.bodyEnLines.join('\n').trim();
      entry.snippet = entry.snippetLines.join('\n').trim();
      // 音を出せるのはチャンネル行を含むエントリだけ(ヘッダ指示子や定義だけの項目は再生ボタンを出さない)
      entry.playable = entry.snippetLines.some(l => CHANNEL_LINE_RE.test(l.trim()));
      if (!entry.title) entry.title = entry.commands.join(' ');
      if (!entry.category) entry.category = entry.chapter;
      if (entry.snippetLines.length === 0 && !entry.docOnly) {
        errors.push({ lineNo: entry.lineNo, level: 'warn', message: T('実演スニペットがありません'), entry });
      }
      entries.push(entry);
      entry = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      const lineNo = i + 1;

      // セクション見出し(罫線+見出し行)はエントリの区切りでもある
      const beforeChapter = tracker.current;
      if (tracker.feed(line)) {
        closeEntry();
        if (tracker.current && tracker.current !== beforeChapter && !chapters.includes(tracker.current)) {
          chapters.push(tracker.current);
        }
        continue;
      }

      const tag = HELP_TAG_RE.exec(line);
      if (tag) {
        closeEntry();
        const args = parseTagArgs(tag[1]);
        if (args.commands.length === 0) {
          errors.push({ lineNo, level: 'error', message: T(';@help にコマンド名がありません') });
          continue;
        }
        entry = {
          id: 'help-' + entries.length + '-' + args.commands[0].replace(/[^A-Za-z0-9]/g, ''),
          commands: args.commands,
          title: args.title,
          titleEn: '',
          category: args.category,
          categoryEn: '',
          docOnly: args.docOnly,
          chapter: tracker.current,
          lineNo,
          bodyLines: [],
          bodyEnLines: [],
          snippetLines: []
        };
        continue;
      }

      if (!entry) continue;

      const enTag = HELP_EN_TAG_RE.exec(line);
      if (enTag) {
        const parts = enTag[1].split('::').map(s => s.trim());
        entry.titleEn = parts[0] || '';
        entry.categoryEn = parts[1] || '';
        continue;
      }
      const enBody = BODY_EN_RE.exec(line);
      if (enBody) { entry.bodyEnLines.push(enBody[1]); continue; }

      if (COMMENT_RE.test(line)) {
        entry.bodyLines.push(line.replace(/^;\s?/, ''));
        continue;
      }
      if (line === '') {
        // 空行はブロックを終わらせない。ただしスニペットの見た目は保つ
        if (entry.snippetLines.length > 0) entry.snippetLines.push('');
        continue;
      }
      entry.snippetLines.push(raw);
    }
    closeEntry();

    // 末尾の空行を落とす + 重複コマンドの検出
    const seen = new Map();
    for (const e of entries) {
      e.snippet = e.snippet.replace(/\n{2,}$/,'').trim();
      for (const c of e.commands) {
        if (seen.has(c)) {
          errors.push({
            lineNo: e.lineNo, level: 'warn',
            message: T('コマンド {cmd} の解説が重複しています({line}行目にもあります)', { cmd: c, line: seen.get(c) })
          });
        } else seen.set(c, e.lineNo);
      }
    }
    return { entries, chapters, errors };
  };

  /*
   * 曲全体から「定義行」(@… = { … } / $マクロ)を、複数行にまたがるものも含めて集める。
   * ヘルプの実演スニペットは定義がどこに書かれていても鳴らせる必要があるため。
   */
  HelpIndex.collectDefinitions = function (source) {
    const lines = splitLines(source);
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (MACRO_DEF_RE.test(trimmed)) { blocks.push([line]); continue; }
      if (!DEF_START_RE.test(trimmed)) continue;
      const block = [line];
      let depth = 0;
      const countBraces = (s) => {
        const noComment = s.split(';')[0];
        for (const ch of noComment) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
      };
      countBraces(line);
      while (depth > 0 && i + 1 < lines.length) {
        i++;
        block.push(lines[i]);
        countBraces(lines[i]);
      }
      blocks.push(block);
    }
    return blocks.map(b => b.join('\n'));
  };

  HelpIndex.collectDirectives = function (source) {
    return splitLines(source).filter(l => /^#(EX-|OCTAVE-REV|GATE-DENOM)/i.test(l.trim()));
  };

  // スニペットが使っているチャンネル文字
  function channelsOf(snippet) {
    const set = [];
    for (const line of splitLines(snippet)) {
      const m = CHANNEL_LINE_RE.exec(line.trim());
      if (m && !set.includes(m[1])) set.push(m[1]);
    }
    return set;
  }

  /*
   * そのチャンネルの直近のセットアップ行(テンポ/音長/オクターブ/音量を決めている行)を探す。
   * これが無いと、スニペット単体ではテンポも音色も既定値になって「解説と鳴り方が違う」状態になる。
   */
  HelpIndex.setupLineFor = function (source, channel, beforeLineNo) {
    const lines = splitLines(source);
    const limit = Math.min(beforeLineNo != null ? beforeLineNo - 1 : lines.length, lines.length);
    for (let i = limit - 1; i >= 0; i--) {
      const line = lines[i].trim();
      const m = CHANNEL_LINE_RE.exec(line);
      if (!m || m[1] !== channel) continue;
      if (SETUP_HINT_RE.test(m[2])) return lines[i];
    }
    return null;
  };

  HelpIndex.playableSource = function (source, entry) {
    if (!entry) return '';
    const out = [];
    out.push(...HelpIndex.collectDirectives(source));
    out.push(...HelpIndex.collectDefinitions(source));
    const snippetLines = splitLines(entry.snippet);
    for (const ch of channelsOf(entry.snippet)) {
      const setup = HelpIndex.setupLineFor(source, ch, entry.lineNo);
      if (setup) out.push(setup);
      else out.push(`${ch} t150 l4 o4 v12`);
    }
    // 定義行はもう上でまとめて入れてあるので、スニペット側では飛ばす(二重定義を避ける)
    let skipDepth = 0;
    for (const line of snippetLines) {
      const trimmed = line.trim();
      if (skipDepth > 0) {
        for (const ch of trimmed.split(';')[0]) {
          if (ch === '{') skipDepth++;
          else if (ch === '}') skipDepth--;
        }
        continue;
      }
      if (DEF_START_RE.test(trimmed) || MACRO_DEF_RE.test(trimmed)) {
        const body = trimmed.split(';')[0];
        for (const ch of body) {
          if (ch === '{') skipDepth++;
          else if (ch === '}') skipDepth--;
        }
        continue;
      }
      if (trimmed === '') continue;
      out.push(line);
    }
    return out.join('\n') + '\n';
  };

  /*
   * 自己点検。ヘルプが実装から取り残されていないかを機械的に見る。
   *   compileFn … MML.Mml.compile 互換(省略時はコンパイル検査を飛ばす)
   */
  HelpIndex.lint = function (source, compileFn) {
    const parsed = HelpIndex.parse(source);
    const issues = parsed.errors.map(e => ({
      level: e.level || 'error', lineNo: e.lineNo, message: e.message
    }));
    for (const entry of parsed.entries) {
      if (!entry.body) {
        issues.push({ level: 'warn', lineNo: entry.lineNo, message: T('{cmds}: 説明本文がありません', { cmds: entry.commands.join(' ') }) });
      }
      if (!compileFn || !entry.snippet) continue;
      let compiled = null;
      try {
        compiled = compileFn(HelpIndex.playableSource(source, entry), {});
      } catch (err) {
        issues.push({ level: 'error', lineNo: entry.lineNo, message: T('{cmds}: 実演スニペットが例外で落ちました ({msg})', { cmds: entry.commands.join(' '), msg: err && err.message }) });
        continue;
      }
      for (const err of (compiled.errors || [])) {
        issues.push({ level: 'error', lineNo: entry.lineNo, message: T('{cmds}: 実演スニペットがコンパイルエラー — {msg}', { cmds: entry.commands.join(' '), msg: err.message }) });
      }
    }
    return { issues, entries: parsed.entries, chapters: parsed.chapters };
  };

  /*
   * コマンド網羅チェック用の一覧を、compiler.jsの先頭にある「対応コマンド:」ブロックから
   * 機械的に抜き出す(ヘルプ側に第2の正典を作らないため)。ソース文字列を読める環境
   * (ヘッドレスのlintツール)からのみ使う。
   */
  HelpIndex.commandChecklistFromDoc = function (compilerSource) {
    const lines = splitLines(compilerSource);
    const start = lines.findIndex(l => /^\s*\*\s*対応コマンド:/.test(l));
    if (start < 0) return [];
    const cmds = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\*\//.test(line)) break;
      // " *   v<n>           音量 (0-15、絶対指定)" の先頭トークンだけを拾う
      const m = /^\s*\*\s{3}(\S.*)$/.exec(line);
      if (!m) continue;
      const head = m[1];
      // 説明の折り返し行(全角で始まる)は飛ばす
      if (/^[^\x20-\x7E]/.test(head)) continue;
      // 見出し部分("v+<n> v-<n>" / "EN<n> / ENOF" / "@FM<n>={64値}")を取り出す。
      // 括弧の中の "/" は区切りではない(例: "@<n>(X/Y/Z)")ので、括弧内を伏せてから割る
      // 説明文(日本語)が始まる手前まで、あるいは2個以上の空白の手前までが見出し
      const headOnly = head.split(/\s{2,}/)[0].split(/(?=[^\x20-\x7E])/)[0].trim();
      if (!headOnly) continue;
      const masked = headOnly.replace(/[(（][^)）]*[)）]/g, (s) => ' '.repeat(s.length));
      let from = 0;
      const items = [];
      for (let k = 0; k <= masked.length; k++) {
        if (k !== masked.length && masked[k] !== '/') continue;
        const token = headOnly.slice(from, k).trim();
        from = k + 1;
        if (token) items.push(token);
      }
      // "v+<n> v-<n>" や "c d e f g a b" のように空白区切りで複数コマンドが並ぶ見出しは割る。
      // ただし "[ ... ]n" のように空白が構文の一部である書式は割らない
      for (const item of items) {
        if (/[[\]{}.]/.test(item)) { cmds.push(item); continue; }
        for (const t of item.split(/\s+/)) if (t) cmds.push(t);
      }
    }
    return cmds;
  };

  // checklist側の1項目が、ヘルプの掲載コマンド集合でカバーされているか
  HelpIndex.isCommandCovered = function (checklistItem, helpCommands) {
    const target = HelpIndex.normalizeCommand(checklistItem);
    if (!target || target === '<>') return true;   // "<str>" のような引数だけの残骸は無視
    return (helpCommands || []).some((c) => HelpIndex.normalizeCommand(c) === target);
  };

  /*
   * コマンド表記のゆれ(<n>/<num>、"={...}"付き、括弧付きの但し書き)を吸収した比較キー。
   * ヘルプ側の ";@help @FM<n>" と compiler.js の "@FM<n>={64値}" を同じものとみなす。
   */
  HelpIndex.normalizeCommand = function (token) {
    return String(token)
      .replace(/=\s*\{[^}]*\}?/g, '')      // "@FM<n>={64値}" → "@FM<n>"
      .replace(/<[^>]*>/g, '<>')           // <n> と <num> の違いを無視
      .replace(/[(（][^)）]*[)）]/g, '')    // "@<n>(FME7)" の但し書きを落とす
      .replace(/\s+/g, '')
      .toLowerCase();
  };

})(typeof window !== 'undefined' ? window : globalThis);
