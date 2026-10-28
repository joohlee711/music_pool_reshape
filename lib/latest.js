// 레포의 usb_pdb/YYYYMMDD/ 와 recordbox_xml/YYYYMMDD.xml 중 가장 최근 것을 찾아서 불러옴.
// GitHub Pages는 폴더 목록을 못 주니까 GitHub API(공개 레포, 로그인 불필요)로 목록을 보고,
// API가 막히면(시간당 60회 제한 등) 최근 날짜를 하나씩 찔러봄.
(function (root) {
  'use strict';

  const PDB_DIR = 'usb_pdb';
  const XML_DIR = 'recordbox_xml';
  const DATE = /^\d{8}$/;

  // joohlee711.github.io/music_pool_reshape/ 에서 소유자·레포 이름을 읽음. 로컬 테스트용 기본값 포함
  const host = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : 'joohlee711';
  const repoName = location.hostname.endsWith('.github.io') ? (location.pathname.split('/')[1] || 'music_pool_reshape') : 'music_pool_reshape';
  const REPO = { owner: host, repo: repoName, branch: 'main' };

  // 이 스크립트가 있는 lib/ 의 상위 = 사이트 루트
  const SITE = new URL('../', document.currentScript.src).href;

  const pretty = d => d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '';
  const dayDiff = (a, b) => Math.round((Date.parse(pretty(a)) - Date.parse(pretty(b))) / 86400000);

  async function listDir(dir, fresh) {
    const url = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/contents/${dir}?ref=${REPO.branch}`;
    const r = await fetch(url, { cache: fresh ? 'no-store' : 'default', headers: { Accept: 'application/vnd.github+json' } });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('GitHub API ' + r.status);
    return r.json();
  }

  // 배포 직후엔 Pages에 아직 없을 수 있어서 raw.githubusercontent.com으로 한 번 더 시도
  async function getFile(path, as, fresh) {
    const opts = { cache: fresh ? 'no-store' : 'no-cache' };
    let r = await fetch(SITE + path, opts).catch(() => null);
    if (!r || !r.ok) r = await fetch(`https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${REPO.branch}/${path}`, opts).catch(() => null);
    if (!r || !r.ok) return null;
    return as === 'text' ? r.text() : r.arrayBuffer();
  }

  // API 없이 오늘부터 거꾸로 찔러보기
  async function probe(makePath, days) {
    const today = new Date();
    for (let i = 0; i < days; i += 10) {
      const batch = [];
      for (let j = i; j < Math.min(days, i + 10); j++) {
        const d = new Date(today.getTime() - j * 86400000);
        const ds = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        batch.push(fetch(SITE + makePath(ds), { method: 'HEAD', cache: 'no-cache' }).then(r => r.ok ? ds : null).catch(() => null));
      }
      const hit = (await Promise.all(batch)).find(Boolean);
      if (hit) return hit;
    }
    return null;
  }

  async function latestDates(fresh) {
    try {
      const [pdbs, xmls] = await Promise.all([listDir(PDB_DIR, fresh), listDir(XML_DIR, fresh)]);
      const pdbDates = pdbs.filter(e => e.type === 'dir' && DATE.test(e.name)).map(e => e.name).sort();
      const xmlDates = xmls.filter(e => e.type === 'file' && /^\d{8}\.xml$/i.test(e.name)).map(e => e.name.slice(0, 8)).sort();
      return { pdb: pdbDates.pop() || null, xml: xmlDates.pop() || null, via: 'api' };
    } catch (e) {
      const [pdb, xml] = await Promise.all([
        probe(d => `${PDB_DIR}/${d}/export.pdb`, 45),
        probe(d => `${XML_DIR}/${d}.xml`, 45),
      ]);
      return { pdb, xml, via: 'probe', apiError: e.message };
    }
  }

  // what: { pdb: true, ext: true, xml: true } 중 필요한 것만
  async function load(what, fresh) {
    const dates = await latestDates(fresh);
    const out = { dates, pdb: null, ext: null, xml: null };
    const jobs = [];
    if (what.pdb && dates.pdb) jobs.push(getFile(`${PDB_DIR}/${dates.pdb}/export.pdb`, 'buf', fresh).then(b => { out.pdb = b; }));
    if (what.ext && dates.pdb) jobs.push(getFile(`${PDB_DIR}/${dates.pdb}/exportExt.pdb`, 'buf', fresh).then(b => { out.ext = b; }));
    if (what.xml && dates.xml) jobs.push(getFile(`${XML_DIR}/${dates.xml}.xml`, 'text', fresh).then(t => { out.xml = t; }));
    await Promise.all(jobs);
    return out;
  }

  // 화면에 붙일 한 줄 요약
  function describe(res, what) {
    const parts = [];
    if (what.pdb) parts.push(res.dates.pdb ? `USB pdb ${pretty(res.dates.pdb)}` : 'USB pdb 없음');
    if (what.xml) parts.push(res.dates.xml ? `라이브러리 XML ${pretty(res.dates.xml)}` : '라이브러리 XML 없음');
    let warn = '';
    if (what.pdb && what.xml && res.dates.pdb && res.dates.xml && res.dates.pdb !== res.dates.xml) {
      const d = dayDiff(res.dates.xml, res.dates.pdb);
      warn = `두 파일 날짜가 ${Math.abs(d)}일 차이 나. 결과가 실제와 다를 수 있어.`;
    }
    if (res.dates.via === 'probe') warn = (warn ? warn + ' ' : '') + `GitHub 목록을 못 읽어서(${res.dates.apiError}) 최근 45일에서 직접 찾았어.`;
    return { text: parts.join(' · '), warn };
  }

  root.LatestData = { load, describe, pretty, REPO, PDB_DIR, XML_DIR };
})(this);
