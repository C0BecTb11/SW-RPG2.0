/* Куски местности в фоне: главный поток просит кусок (cx, cy, ppc, CH), здесь он рисуется
 * на OffscreenCanvas и уходит назад картинкой (ImageBitmap). Подложку всей карты (k: 'base') —
 * точками. Своя копия карты и Terrain. ES5. */
importScripts('../shared/rt-planets.js?v=3', 'terrain.js?v=7');
var T = null, gen = 0;
onmessage = function(e) {
  var m = e.data;
  if (m.k === 'map') { T = GTerrain.create(m.json); gen = m.gen; return; }
  // грубая подложка всей карты: точки — назад массивом (без чтения из видеокарты в главном потоке)
  if (m.k === 'base' && T && m.gen === gen) {
    var w = m.n * m.ppc, bc = new OffscreenCanvas(w, w), bx = bc.getContext('2d', { willReadFrequently: true });
    T.render(bx, 0, 0, m.n, m.n, m.ppc);
    var img = bx.getImageData(0, 0, w, w);
    postMessage({ k: 'base', gen: gen, w: w, buf: img.data.buffer }, [img.data.buffer]);
    return;
  }
  if (m.k === 'chunk' && T && m.gen === gen) {
    var px = m.CH * m.ppc, cv = new OffscreenCanvas(px, px);
    T.render(cv.getContext('2d'), m.cx * m.CH, m.cy * m.CH, m.CH, m.CH, m.ppc);
    var bmp = cv.transferToImageBitmap();
    postMessage({ k: 'chunk', key: m.key, gen: gen, bmp: bmp }, [bmp]);
  }
};
