// PC rekordbox XML ↔ USB export.pdb 대조 로직. 브라우저에서만 돌고 아무것도 업로드하지 않음.
(function (root) {
  'use strict';

  // 아티스트·제목 정규화: NFC, 소문자, 괄호 안 feat./ft. 제거, & → and, 공백 정리
  function norm(s) {
    return String(s || '').normalize('NFC').toLowerCase()
      .replace(/[([]\s*(feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]/g, ' ')
      .replace(/\s*&\s*/g, ' and ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const stem = name => norm(String(name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''));
  const extOf = name => { const m = String(name || '').match(/\.([^./\\]+)$/); return m ? m[1].toUpperCase() : ''; };
  const keyOf = (artist, title) => norm(artist) + '\u0001' + norm(title);

  // file://localhost/Users/me/Desktop/Music/a%20b.mp3 → /Users/me/Desktop/Music/a b.mp3
  function decodeLocation(loc) {
    let p = String(loc || '').replace(/^file:\/\/localhost/i, '').replace(/^file:\/\//i, '');
    try { p = decodeURIComponent(p); } catch (e) { p = p.replace(/%20/g, ' '); }
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // Windows: /C:/Users/... → C:/Users/...
    return p.normalize('NFC');
  }

  // 홈 폴더 앞부분을 떼서 보기 좋게: /Users/me/Desktop/Music → Desktop/Music
  function shortDir(path) {
    const dir = path.replace(/[\\/][^\\/]*$/, '');
    return dir.replace(/^(\/Users\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)[\\/]?/i, '') || dir;
  }

  // rekordbox 컬렉션 XML 문서(DOM) → { tracks, playlistCount }
  function parseRekordboxXml(doc) {
    if (!doc || doc.getElementsByTagName('parsererror').length) throw new Error('XML을 읽지 못했어');
    const rootEl = doc.documentElement;
    if (!rootEl || rootEl.nodeName !== 'DJ_PLAYLISTS') throw new Error('rekordbox XML(DJ_PLAYLISTS)이 아니야');
    const coll = [...rootEl.children].find(e => e.nodeName === 'COLLECTION');
    if (!coll) throw new Error('COLLECTION이 없어');

    const tracks = [];
    const byId = new Map(), byLoc = new Map();
    for (const el of coll.children) {
      if (el.nodeName !== 'TRACK') continue;
      const a = n => el.getAttribute(n) || '';
      const path = decodeLocation(a('Location'));
      const file = path.replace(/^.*[\\/]/, '');
      const t = {
        id: a('TrackID'), title: a('Name'), artist: a('Artist'), album: a('Album'),
        bpm: parseFloat(a('AverageBpm')) || 0, dateAdded: a('DateAdded'), kind: a('Kind'),
        path, file, dir: shortDir(path), format: extOf(file) || a('Kind').replace(/\s*File$/i, '').toUpperCase(),
        playlists: [],
      };
      tracks.push(t);
      byId.set(t.id, t);
      byLoc.set(a('Location'), t);
    }

    // PLAYLISTS > NODE 트리. Type 0 = 폴더, 1 = 플레이리스트. KeyType 0 = TrackID, 1 = Location
    let playlistCount = 0;
    const pls = [...rootEl.children].find(e => e.nodeName === 'PLAYLISTS');
    (function walk(node, path) {
      for (const n of node.children) {
        if (n.nodeName !== 'NODE') continue;
        const name = n.getAttribute('Name') || '';
        const isRoot = path.length === 0 && name === 'ROOT' && n.getAttribute('Type') === '0';
        const p = isRoot ? path : path.concat(name);
        if (n.getAttribute('Type') === '1') {
          playlistCount++;
          const byLocation = n.getAttribute('KeyType') === '1';
          const label = p.join('/');
          for (const e of n.children) {
            if (e.nodeName !== 'TRACK') continue;
            const k = e.getAttribute('Key');
            const t = byLocation ? byLoc.get(k) : byId.get(k);
            if (t && !t.playlists.includes(label)) t.playlists.push(label);
          }
        } else walk(n, p);
      }
    })(pls || { children: [] }, []);

    return { tracks, playlistCount };
  }

  // USB 라이브러리(RekordboxPdb.buildLibrary 결과) → 대조용 곡 목록
  function usbTracks(lib) {
    const lists = new Map();
    (function walk(nodes, path) {
      for (const n of nodes) {
        const p = path.concat(n.name);
        if (n.isFolder) walk(n.children, p);
        else n.trackIds.forEach(id => {
          if (!lists.has(id)) lists.set(id, []);
          const label = p.join('/');
          if (!lists.get(id).includes(label)) lists.get(id).push(label);
        });
      }
    })(lib.playlists, []);
    return lib.tracks.map(t => ({
      id: t.id, title: t.title, artist: t.artist, album: t.album, bpm: t.bpm, dateAdded: t.dateAdded,
      path: t.filePath, file: t.filename || String(t.filePath || '').replace(/^.*\//, ''),
      format: extOf(t.filePath), playlists: lists.get(t.id) || [],
    }));
  }

  // 대조. PC 쪽은 아티스트+제목이 같은 파일(mp3/aiff 중복)을 한 묶음으로 처리
  function compare(pc, usb) {
    const groups = new Map();
    for (const t of pc) {
      const k = keyOf(t.artist, t.title);
      if (!groups.has(k)) groups.set(k, { key: k, files: [] });
      groups.get(k).files.push(t);
    }
    const pcGroups = [...groups.values()].map(g => {
      const f = g.files;
      const uniq = arr => [...new Set(arr.filter(Boolean))];
      return {
        key: g.key, files: f, dup: f.length > 1,
        artist: f[0].artist, title: f[0].title,
        playlists: uniq(f.flatMap(x => x.playlists)),
        dateAdded: f.map(x => x.dateAdded).filter(Boolean).sort()[0] || '',
        bpm: f[0].bpm, formats: uniq(f.map(x => x.format)), dirs: uniq(f.map(x => x.dir)),
        stems: uniq(f.map(x => stem(x.file))),
      };
    });

    const usbItems = usb.map(t => ({ ...t, key: keyOf(t.artist, t.title), stem: stem(t.file), matched: false }));
    const usbByKey = new Map();
    usbItems.forEach(u => { if (!usbByKey.has(u.key)) usbByKey.set(u.key, []); usbByKey.get(u.key).push(u); });

    const both = [];
    // 1차: 아티스트+제목
    for (const g of pcGroups) {
      const hit = usbByKey.get(g.key);
      if (hit) { hit.forEach(u => { u.matched = true; }); g.match = { method: 1, usb: hit }; both.push(g); }
    }
    // 2차: 남은 것끼리 파일명
    const usbByStem = new Map();
    usbItems.filter(u => !u.matched && u.stem).forEach(u => { if (!usbByStem.has(u.stem)) usbByStem.set(u.stem, []); usbByStem.get(u.stem).push(u); });
    for (const g of pcGroups) {
      if (g.match) continue;
      const hit = g.stems.flatMap(s => (usbByStem.get(s) || []).filter(u => !u.matched));
      if (hit.length) { hit.forEach(u => { u.matched = true; }); g.match = { method: 2, usb: hit }; both.push(g); }
    }

    return {
      pcOnly: pcGroups.filter(g => !g.match),
      usbOnly: usbItems.filter(u => !u.matched),
      both,
      stats: {
        pcFiles: pc.length, pcSongs: pcGroups.length, usb: usb.length,
        dupGroups: pcGroups.filter(g => g.dup).length,
        byKey: both.filter(g => g.match.method === 1).length,
        byFile: both.filter(g => g.match.method === 2).length,
      },
    };
  }

  // UTF-8 BOM 포함 CSV (엑셀 한글 깨짐 방지)
  function toCsv(header, rows) {
    const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return '\uFEFF' + [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  const api = { norm, stem, keyOf, decodeLocation, shortDir, parseRekordboxXml, usbTracks, compare, toCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RekordboxDiff = api;
})(this);
