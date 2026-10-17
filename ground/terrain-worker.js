/* Куски местности в фоне: главный поток просит кусок (cx, cy, ppc, CH), здесь он рисуется
 * на OffscreenCanvas и уходит назад картинкой (ImageBitmap). Своя копия карты и Terrain. ES5. */
importScripts('../shared/rt-planets.js?v=2', 'terrain.js?v=3');
var T = null, gen = 0;
onmessage = function(e) {
  var m = e.data;
  if (m.k === 'map') { T = GTerrain.create(m.json); gen = m.gen; return; }
  if (m.k === 'chunk' && T && m.gen === gen) {
    var px = m.CH * m.ppc, cv = new OffscreenCanvas(px, px);
    T.render(cv.getContext('2d'), m.cx * m.CH, m.cy * m.CH, m.CH, m.CH, m.ppc);
    var bmp = cv.transferToImageBitmap();
    postMessage({ k: 'chunk', key: m.key, gen: gen, bmp: bmp }, [bmp]);
  }
};
