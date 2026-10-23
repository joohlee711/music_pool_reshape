// rekordbox export.pdb / exportExt.pdb 읽기 전용 파서.
// 포맷 출처: Deep Symmetry crate-digger 분석 문서 (rekordbox_pdb.ksy).
(function (root) {
  'use strict';

  const TABLE = { tracks: 0, genres: 1, artists: 2, albums: 3, labels: 4, keys: 5, colors: 6,
    playlistTree: 7, playlistEntries: 8, historyPlaylists: 11, historyEntries: 12 };
  const EXT_TABLE = { tags: 3, tagTracks: 4 };

  // 트랙 행 끝의 문자열 오프셋 21개 순서
  const TRACK_STRINGS = ['isrc', 'texter', 'unknown2', 'unknown3', 'unknown4', 'message', 'kuvoPublic',
    'autoloadHotcues', 'unknown5', 'unknown6', 'dateAdded', 'releaseDate', 'mixName', 'unknown7',
    'analyzePath', 'analyzeDate', 'comment', 'title', 'unknown8', 'filename', 'filePath'];

  const latin1 = new TextDecoder('latin1');
  const utf16 = new TextDecoder('utf-16le');
  const utf8 = new TextDecoder('utf-8');

  function openPdb(buffer) {
    const dv = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const u8 = o => dv.getUint8(o);
    const u16 = o => dv.getUint16(o, true);
    const u32 = o => dv.getUint32(o, true);
    const pageLen = u32(4);
    const numTables = u32(8);
    if (!pageLen || pageLen > 0x10000 || numTables > 64) throw new Error('rekordbox pdb 파일이 아닌 것 같아');

    const tables = {};
    for (let i = 0; i < numTables; i++) {
      const o = 28 + 16 * i;
      tables[u32(o)] = { first: u32(o + 8), last: u32(o + 12) };
    }

    // DeviceSQL 문자열: 짧은 ASCII / 긴 ASCII(0x40) / 긴 UTF-16LE(0x90)
    function str(o) {
      if (o <= 0 || o >= bytes.length) return '';
      const kind = u8(o);
      if (kind & 1) {
        const len = (kind >> 1) - 1;
        return len > 0 ? utf8.decode(bytes.subarray(o + 1, o + 1 + len)) : '';
      }
      const len = u16(o + 1) - 4;
      if (len <= 0) return '';
      const body = bytes.subarray(o + 4, o + 4 + len);
      if (kind === 0x90) return utf16.decode(body).replace(/\0+$/, '');
      return latin1.decode(body).replace(/\0+$/, '');
    }

    // 테이블의 모든 페이지를 따라가며 살아있는 행의 시작 위치를 넘겨줌
    function rows(type) {
      const t = tables[type];
      const out = [];
      if (!t) return out;
      const seen = new Set();
      let p = t.first;
      while (!seen.has(p) && (p + 1) * pageLen <= bytes.length) {
        seen.add(p);
        const base = p * pageLen;
        const flags = u8(base + 27);
        if (u32(base + 8) === type && (flags & 0x40) === 0) {
          const numOffsets = (u8(base + 24) | (u8(base + 25) << 8) | (u8(base + 26) << 16)) & 0x1fff;
          for (let i = 0; i < numOffsets; i++) {
            const group = base + pageLen - Math.floor(i / 16) * 0x24;
            const bit = i % 16;
            if (!(u16(group - 4) & (1 << bit))) continue;
            out.push(base + 0x28 + u16(group - 6 - 2 * bit));
          }
        }
        if (p === t.last) break;
        p = u32(base + 12);
      }
      return out;
    }

    // 아티스트·앨범·태그처럼 이름 오프셋이 near(u1)/far(u2) 두 가지인 행
    function nearFarName(r, nearAt, farAt, subtypeFar) {
      const far = (u16(r) & 0x04) && subtypeFar;
      return str(r + (far ? u16(r + farAt) : u8(r + nearAt)));
    }

    return { u8, u16, u32, str, rows, nearFarName, tables };
  }

  function idMap(list) {
    const m = new Map();
    for (const x of list) m.set(x.id, x);
    return m;
  }

  function parseExport(buffer) {
    const db = openPdb(buffer);
    const { u8, u16, u32, str, rows } = db;

    const simple = (type, nameAt) => rows(type).map(r => ({ id: u32(r), name: str(r + nameAt) }));
    const genres = simple(TABLE.genres, 4);
    const labels = simple(TABLE.labels, 4);
    const keys = simple(TABLE.keys, 8);
    const colors = rows(TABLE.colors).map(r => ({ id: u16(r + 5), name: str(r + 8) }));
    const artists = rows(TABLE.artists).map(r => ({ id: u32(r + 4), name: db.nearFarName(r, 9, 10, true) }));
    const albums = rows(TABLE.albums).map(r => ({ id: u32(r + 12), artistId: u32(r + 8), name: db.nearFarName(r, 21, 22, true) }));

    const tracks = rows(TABLE.tracks).map(r => {
      const s = {};
      TRACK_STRINGS.forEach((name, i) => { s[name] = str(r + u16(r + 0x5e + 2 * i)); });
      return {
        id: u32(r + 72),
        title: s.title,
        artistId: u32(r + 68),
        originalArtistId: u32(r + 36),
        remixerId: u32(r + 44),
        composerId: u32(r + 12),
        albumId: u32(r + 64),
        genreId: u32(r + 60),
        labelId: u32(r + 40),
        keyId: u32(r + 32),
        colorId: u8(r + 88),
        rating: u8(r + 89),
        bpm: u32(r + 56) / 100,
        duration: u16(r + 84),
        bitrate: u32(r + 48),
        sampleRate: u32(r + 8),
        sampleDepth: u16(r + 82),
        fileSize: u32(r + 16),
        trackNumber: u32(r + 52),
        discNumber: u16(r + 76),
        year: u16(r + 80),
        playCount: u16(r + 78),
        artworkId: u32(r + 28),
        mixName: s.mixName,
        comment: s.comment,
        dateAdded: s.dateAdded,
        releaseDate: s.releaseDate,
        analyzeDate: s.analyzeDate,
        filename: s.filename,
        filePath: s.filePath,
        isrc: s.isrc,
        message: s.message,
      };
    });

    const playlists = rows(TABLE.playlistTree).map(r => ({
      parentId: u32(r), sortOrder: u32(r + 8), id: u32(r + 12), isFolder: u32(r + 16) !== 0, name: str(r + 20),
    }));
    const playlistEntries = rows(TABLE.playlistEntries).map(r => ({ index: u32(r), trackId: u32(r + 4), playlistId: u32(r + 8) }));
    const historyPlaylists = simple(TABLE.historyPlaylists, 4);
    const historyEntries = rows(TABLE.historyEntries).map(r => ({ trackId: u32(r), playlistId: u32(r + 4), index: u32(r + 8) }));

    return { genres, labels, keys, colors, artists, albums, tracks, playlists, playlistEntries, historyPlaylists, historyEntries };
  }

  function parseExportExt(buffer) {
    const db = openPdb(buffer);
    const { u32, rows } = db;
    const tags = rows(EXT_TABLE.tags).map(r => ({
      categoryId: u32(r + 12), position: u32(r + 16), id: u32(r + 20),
      isCategory: u32(r + 24) !== 0, name: db.nearFarName(r, 29, 30, false),
    }));
    const tagTracks = rows(EXT_TABLE.tagTracks).map(r => ({ trackId: u32(r + 4), tagId: u32(r + 8) }));
    return { tags, tagTracks };
  }

  // 원시 테이블을 화면에서 쓰기 좋은 형태로 합침
  function buildLibrary(exp, ext) {
    const artists = idMap(exp.artists), albums = idMap(exp.albums), genres = idMap(exp.genres);
    const labels = idMap(exp.labels), keys = idMap(exp.keys), colors = idMap(exp.colors);
    const name = (m, id) => (id && m.get(id) ? m.get(id).name : '');

    const tagsById = idMap(ext ? ext.tags : []);
    const tagsByTrack = new Map();
    for (const tt of ext ? ext.tagTracks : []) {
      const tag = tagsById.get(tt.tagId);
      if (!tag) continue;
      if (!tagsByTrack.has(tt.trackId)) tagsByTrack.set(tt.trackId, []);
      tagsByTrack.get(tt.trackId).push(tag.name);
    }

    const tracks = exp.tracks.map(t => ({
      ...t,
      artist: name(artists, t.artistId),
      album: name(albums, t.albumId),
      genre: name(genres, t.genreId),
      label: name(labels, t.labelId),
      key: name(keys, t.keyId),
      color: name(colors, t.colorId),
      remixer: name(artists, t.remixerId),
      originalArtist: name(artists, t.originalArtistId),
      tags: tagsByTrack.get(t.id) || [],
    }));
    const trackById = idMap(tracks);

    const entriesBy = (list) => {
      const m = new Map();
      for (const e of list) {
        if (!m.has(e.playlistId)) m.set(e.playlistId, []);
        m.get(e.playlistId).push(e);
      }
      for (const l of m.values()) l.sort((a, b) => a.index - b.index);
      return m;
    };
    const plEntries = entriesBy(exp.playlistEntries);
    const histEntries = entriesBy(exp.historyEntries);

    const nodes = new Map(exp.playlists.map(p => [p.id, {
      ...p, children: [], trackIds: (plEntries.get(p.id) || []).map(e => e.trackId),
    }]));
    const rootNodes = [];
    for (const n of nodes.values()) (nodes.get(n.parentId)?.children || rootNodes).push(n);
    const sortTree = list => { list.sort((a, b) => a.sortOrder - b.sortOrder); list.forEach(n => sortTree(n.children)); };
    sortTree(rootNodes);

    const history = exp.historyPlaylists.map(h => ({
      ...h, trackIds: (histEntries.get(h.id) || []).map(e => e.trackId),
    }));

    const tagCategories = (ext ? ext.tags : []).filter(t => t.isCategory).sort((a, b) => a.position - b.position)
      .map(c => ({ ...c, tags: ext.tags.filter(t => !t.isCategory && t.categoryId === c.id).sort((a, b) => a.position - b.position) }));

    return { tracks, trackById, playlists: rootNodes, history, tagCategories, raw: { exp, ext } };
  }

  const api = { parseExport, parseExportExt, buildLibrary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RekordboxPdb = api;
})(this);
