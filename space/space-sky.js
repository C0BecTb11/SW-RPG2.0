/* Небо орбиты (бой 2.0): холст под боем — туманность, звёзды в три слоя с параллаксом, планета системы
 * шаром с вращением, облаками, атмосферой и терминатором, солнце с ореолом, лучами и бликами.
 *
 * WebGL 1, один полноэкранный проход. Туманность печётся в текстуру один раз на систему (domain-warp fbm),
 * звёзды — в три повторяющиеся текстуры 512² (2D-холст), планета — текстура системы assets/planets/<id>.png
 * (равнопромежуточная развёртка 2:1, приводится к 1024×512 ради повтора по долготе).
 * Камера боя двигает слои с разной глубиной (км → точки: туманность 3, звёзды 6/12/22, планета 9),
 * масштаб чуть растит ближние слои — орбита «над планетой» живёт при каждом движении.
 * Нет WebGL — холст не создаётся, остаётся прежний фон страницы (space.css).
 * Перерисовка — при движении камеры, иначе не чаще 20 раз в секунду (мерцание, вращение); «меньше движения»
 * и «Экономия заряда» — без мерцания и вращения. Качество — по SPGfx: плотность холста.
 * ES5.
 */
(function(root) {
  'use strict';

  // Атмосфера и облака по планетам (цвет ореола, доля облаков, свечение ночной стороны: lava — лава, city — огни)
  var LOOK = {
    coruscant: { atm: [0.55, 0.72, 1.0], cloud: 0.18, city: 1 },
    kuat: { atm: [0.55, 0.74, 1.0], cloud: 0.35, city: 0.5 },
    naboo: { atm: [0.5, 0.76, 1.0], cloud: 0.55 },
    kamino: { atm: [0.58, 0.8, 1.0], cloud: 0.8 },
    alderaan: { atm: [0.55, 0.76, 1.0], cloud: 0.5 },
    corellia: { atm: [0.55, 0.75, 1.0], cloud: 0.45, city: 0.35 },
    anaxes: { atm: [0.6, 0.75, 1.0], cloud: 0.4, city: 0.3 },
    muunilinst: { atm: [0.55, 0.78, 1.0], cloud: 0.45, city: 0.3 },
    kashyyyk: { atm: [0.55, 0.85, 0.75], cloud: 0.5 },
    christophsis: { atm: [0.6, 0.85, 1.0], cloud: 0.3 },
    umbara: { atm: [0.5, 0.42, 0.95], cloud: 0.65 },
    mustafar: { atm: [1.0, 0.42, 0.18], cloud: 0.12, lava: 1 },
    geonosis: { atm: [1.0, 0.62, 0.38], cloud: 0.08 },
    ryloth: { atm: [1.0, 0.75, 0.45], cloud: 0.15 },
    utapau: { atm: [0.95, 0.78, 0.55], cloud: 0.2 },
    hypori: { atm: [0.9, 0.66, 0.45], cloud: 0.2 },
    raxus: { atm: [0.7, 0.75, 1.0], cloud: 0.4, city: 0.3 },
    catoneimoidia: { atm: [0.7, 0.75, 0.95], cloud: 0.45, city: 0.4 },
    maygito: { atm: [0.6, 0.8, 1.0], cloud: 0.4 },
    feorust: { atm: [0.65, 0.8, 1.0], cloud: 0.35 }
  };
  var DEF_LOOK = { atm: [0.55, 0.75, 1.0], cloud: 0.4 };

  var VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var NOISE =
    'float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}' +
    'float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);' +
    'return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x),mix(h21(i+vec2(0.,1.)),h21(i+vec2(1.,1.)),f.x),f.y);}' +
    'float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<6;i++){s+=a*vn(p);p=p*2.03+vec2(17.1,9.2);a*=.5;}return s;}';
  // Туманность: две краски по системе, тёмные прожилки пыли, редкие яркие узлы
  var PREC = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';
  var FS_NEB = PREC + 'uniform vec2 uR;uniform vec3 uA;uniform vec3 uB;uniform float uSeed;' + NOISE +
    'void main(){vec2 uv=gl_FragCoord.xy/uR;vec2 p=uv*3.+uSeed;' +
    'vec2 q=vec2(fbm(p),fbm(p+vec2(5.2,1.3)));vec2 r=vec2(fbm(p+3.*q+vec2(1.7,9.2)),fbm(p+3.*q+vec2(8.3,2.8)));' +
    'float f=fbm(p+3.5*r);float m=smoothstep(.35,.95,f);' +
    'vec3 c=mix(uA,uB,clamp(length(q)*.9,0.,1.))*m*m*1.15;' +
    'float dust=smoothstep(.45,.75,fbm(p*1.7+r*2.+11.));c*=1.-.65*dust;' +
    'float knot=pow(smoothstep(.72,1.,f),3.);c+=mix(uB,vec3(1.),.4)*knot*.55;' +
    'float edge=smoothstep(.0,.25,uv.x)*smoothstep(1.,.75,uv.x)*smoothstep(.0,.25,uv.y)*smoothstep(1.,.75,uv.y);' +
    'gl_FragColor=vec4(c*mix(.35,1.,edge),1.);}';
  var FS = PREC +
    'uniform vec2 uR;uniform float uT,uMo;' +
    'uniform sampler2D uNeb,uS0,uS1,uS2,uPl;' +
    'uniform vec4 uNebR;uniform vec2 uO0,uO1,uO2;uniform vec3 uSs;' +
    'uniform float uPOn,uPR,uRot,uCl,uLava,uCity;uniform vec2 uPC;uniform mat3 uPM;uniform vec3 uL,uAtm;' +
    'uniform vec2 uSun;uniform vec3 uSunC;uniform float uSunK;' + NOISE +
    // облака — настоящий трёхмерный шум на сфере (проекция в 2D давала полосы у края диска)
    'float h31(vec3 p){p=fract(p*vec3(.1031,.1030,.0973));p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}' +
    'float vn3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);' +
    'return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),' +
    'mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z);}' +
    'float fbm3(vec3 p){float a=.5,s=0.;for(int i=0;i<5;i++){s+=a*vn3(p);p=p*2.03+vec3(3.1,7.7,1.3);a*=.5;}return s;}' +
    'vec3 lin(vec3 c){return c*c;}' +
    'void main(){vec2 fc=gl_FragCoord.xy;float mn=min(uR.x,uR.y);' +
    // туманность: прямоугольник текстуры на экране (x0,y0,ширина,высота)
    'vec2 nu=(fc-uNebR.xy)/uNebR.zw;vec3 col=texture2D(uNeb,clamp(nu,0.,1.)).rgb*.9;' +
    // звёзды: три слоя, ближние ярче; мерцание — по ячейкам, медленно
    'vec3 s0=texture2D(uS0,(fc+uO0)/(512.*uSs.x)).rgb;vec3 s1=texture2D(uS1,(fc+uO1)/(512.*uSs.y)).rgb;vec3 s2=texture2D(uS2,(fc+uO2)/(512.*uSs.z)).rgb;' +
    'float tw=1.;if(uMo>0.){vec2 cl=floor((fc+uO2)/23.);tw=.72+.28*sin(uT*(1.2+h21(cl)*2.6)+h21(cl+7.)*6.28);}' +
    'col+=s0*.55+s1*.85+s2*tw*1.1;' +
    // солнце: ядро, ореол, лучи, анаморфная полоса
    'vec2 sd=(fc-uSun)/mn;float sl=length(sd);' +
    'float ang=atan(sd.y,sd.x);float rays=(.55+.45*vn(vec2(ang*9.,uT*.08)))*(.6+.4*vn(vec2(ang*23.+3.,uT*.05)));' +
    'vec3 sun=uSunC*(2.2*exp(-sl*30.)+.55*exp(-sl*6.)+.1*exp(-sl*1.6)+rays*.22*exp(-sl*3.6));' +
    'sun+=vec3(.55,.7,1.)*exp(-abs(sd.y)*160.)*exp(-abs(sd.x)*3.)*.12;' +
    'col+=sun*uSunK;' +
    // планета
    'if(uPOn>.5){vec2 d=(fc-uPC)/uPR;float r2=dot(d,d);' +
    'if(r2<1.){float z=sqrt(1.-r2);vec3 n=vec3(d,z);vec3 q=uPM*n;' +
    'float lon=atan(q.x,q.z)+uRot;float lat=asin(clamp(q.y,-1.,1.));' +
    'vec2 tuv=vec2(lon/6.2831853+.5,.5-lat/3.1415927);vec3 alb=lin(texture2D(uPl,tuv).rgb);' +
    // текстура планеты мала для такого размера: мелкий рельеф шумом, чтобы вблизи не было мыла
    'alb*=.9+.2*vn(tuv*vec2(900.,450.))*(.6+.4*vn(tuv*vec2(220.,110.)));' +
    'float dl=dot(n,uL);float day=smoothstep(-.12,.35,dl);float lam=max(dl,0.);' +
    'float cl=0.;if(uCl>0.){float ca=cos(uRot*1.15),sa=sin(uRot*1.15);vec3 cr=vec3(q.x*ca+q.z*sa,q.y,-q.x*sa+q.z*ca);cl=smoothstep(.5,.76,fbm3(cr*3.2+vec3(0.,uT*.002,0.)))*uCl;}' +
    'vec3 lit=alb*(.02+1.15*pow(lam,.85))*(1.-cl*.35*day);' +
    'lit=mix(lit,vec3(.95,.97,1.)*(.03+1.05*lam),cl*.85);' +
    'float night=1.-smoothstep(-.25,.05,dl);' +
    'if(uCity>0.){float sp=smoothstep(.55,.85,vn(tuv*vec2(1400.,700.)))*(.4+.6*vn(tuv*vec2(180.,90.)));' +
    'float cityL=smoothstep(.18,.5,alb.r+alb.g-alb.b*.6)*sp*uCity*(1.-cl*.8);lit+=vec3(1.,.78,.45)*cityL*night*.9;}' +
    'if(uLava>0.){float lv=smoothstep(.05,.3,alb.r-alb.g*1.4);lit+=vec3(1.,.35,.08)*lv*uLava*(.35+.65*night);}' +
    'float fr=pow(1.-z,2.6);vec3 atm=uAtm*fr*(.15+1.4*smoothstep(-.3,.6,dl));' +
    'lit+=atm;float limb=smoothstep(1.,.985,sqrt(r2));col=mix(col,sqrt(max(lit,0.)),limb);}' +
    // ореол атмосферы за краем: тонкий яркий и широкий мягкий, со стороны света сильнее
    'float dd=sqrt(r2);if(dd>=.985){vec2 nd=d/dd;float side=smoothstep(-.45,.75,dot(nd,uL.xy)+uL.z*.35);' +
    'float hal=(exp(-(dd-1.)*42.)*.75+exp(-(dd-1.)*7.)*.22)*side;col+=uAtm*hal;}}' +
    // блики линзы: по линии солнце → центр экрана
    'if(uSunK>0.){vec2 cc=uR*.5;vec2 ax=cc-uSun;' +
    'for(int i=0;i<4;i++){float k=.55+float(i)*.48;vec2 gp=uSun+ax*k*1.6;float gr=mn*(.025+.03*float(i));' +
    'float g=smoothstep(gr,gr*.55,length(fc-gp));col+=mix(uSunC,vec3(.5,.7,1.),float(i)*.3)*g*.045*uSunK;}}' +
    // виньетка и зерно против полос
    'vec2 vu=fc/uR-.5;col*=1.-.42*dot(vu,vu)*1.6;col+=(h21(fc+uT)-.5)/255.;' +
    'gl_FragColor=vec4(col,1.);}';

  var S = {
    gl: null, cv: null, prog: null, neb: null, stars: [], pl: null, plKey: null, plReady: false,
    sys: undefined, seed: 1, look: DEF_LOOK, planet: null, last: 0, lastCam: '', failed: false, u: {}
  };

  function rng(seed) { var s = seed >>> 0 || 1; return function() { s += 0x6D2B79F5; var t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hashStr(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function hsl(h, s, l) {
    var a = s * Math.min(l, 1 - l), f = function(n) { var k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)];
  }

  function compile(gl, type, src) {
    var sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'шейдер');
    return sh;
  }
  function program(gl, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'программа');
    return p;
  }
  function tex(gl, src, repeat) {
    var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    var w = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w);
    if (src) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    return t;
  }

  // Звёзды слоя: 512², повторяются; dense — сколько, big — доля крупных (с крестом)
  function starLayer(R, n, bright, big, warm) {
    var cv = document.createElement('canvas'); cv.width = cv.height = 512;
    var c = cv.getContext('2d'); c.fillStyle = '#000'; c.fillRect(0, 0, 512, 512);
    c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < n; i++) {
      var x = R() * 512, y = R() * 512, m = Math.pow(R(), 2.6), rad = 0.5 + m * 1.6 * bright, t = R();
      var col = t < warm ? [255, 214 + R() * 30, 170 + R() * 50] : t > 0.85 ? [170 + R() * 40, 200 + R() * 30, 255] : [235, 240, 255];
      var a = (0.25 + m * 0.75) * bright;
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        var px = x + dx * 512, py = y + dy * 512; if (px < -8 || px > 520 || py < -8 || py > 520) continue;
        var g = c.createRadialGradient(px, py, 0, px, py, rad * 2.4);
        g.addColorStop(0, 'rgba(' + col.map(Math.round).join(',') + ',' + Math.min(1, a) + ')');
        g.addColorStop(0.35, 'rgba(' + col.map(Math.round).join(',') + ',' + (a * 0.35) + ')');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.beginPath(); c.arc(px, py, rad * 2.4, 0, Math.PI * 2); c.fill();
        if (m > 1 - big) {                                    // яркая — крест лучей
          c.strokeStyle = 'rgba(' + col.map(Math.round).join(',') + ',' + (a * 0.35) + ')'; c.lineWidth = 0.7;
          c.beginPath(); c.moveTo(px - rad * 7, py); c.lineTo(px + rad * 7, py); c.moveTo(px, py - rad * 7); c.lineTo(px, py + rad * 7); c.stroke();
        }
      }
    }
    return cv;
  }

  function init() {
    if (S.gl || S.failed) return !!S.gl;
    try {
      var cv = document.createElement('canvas'); cv.id = 'sp-sky'; cv.setAttribute('aria-hidden', 'true');
      var gl = cv.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
      if (!gl) { S.failed = true; return false; }
      S.prog = program(gl, FS); S.nebProg = program(gl, FS_NEB);
      var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      var names = ['uR', 'uT', 'uMo', 'uNeb', 'uS0', 'uS1', 'uS2', 'uPl', 'uNebR', 'uO0', 'uO1', 'uO2', 'uSs', 'uPOn', 'uPR', 'uRot', 'uCl', 'uLava', 'uCity', 'uPC', 'uPM', 'uL', 'uAtm', 'uSun', 'uSunC', 'uSunK'];
      names.forEach(function(k) { S.u[k] = gl.getUniformLocation(S.prog, k); });
      cv.addEventListener('webglcontextlost', function(e) { e.preventDefault(); S.lost = true; });
      cv.addEventListener('webglcontextrestored', function() { S.gl = null; S.failed = false; S.sys = undefined; S.lost = false; S.stars = []; S.neb = null; S.pl = null;   // старые текстуры — от прежнего контекста
        if (cv.parentNode) cv.parentNode.removeChild(cv); init(); });
      var main = document.getElementById('sp-canvas');
      if (main && main.parentNode) main.parentNode.insertBefore(cv, main); else document.body.insertBefore(cv, document.body.firstChild);
      S.gl = gl; S.cv = cv;
      document.body.classList.add('sp-sky-on');
      return true;
    } catch (e) {
      S.failed = true; S.gl = null;
      if (root.errReport) root.errReport(e, 'space.sky');
      return false;
    }
  }

  // Система сменилась: краски, звёзды, туманность, планета, положение солнца
  function setSystem(sys) {
    var gl = S.gl, key = sys ? (sys.id || 'deep') + (sys.deep ? ':deep' : '') : 'stand';
    if (S.sys === key) return;
    S.sys = key; S.seed = hashStr(key); var R = rng(S.seed);
    var pid = sys && !sys.deep && sys.id ? sys.id : null;              // глубокий космос — без планеты
    S.look = (pid && LOOK[pid]) || DEF_LOOK;
    // краски туманности: от атмосферы планеты и случайного соседнего тона
    var atm = S.look.atm, baseH = Math.atan2(Math.sqrt(3) * (atm[1] - atm[2]), 2 * atm[0] - atm[1] - atm[2]) / (2 * Math.PI);
    var h1 = ((baseH + 1) % 1 + (R() - 0.5) * 0.12 + 1) % 1, h2 = (h1 + 0.12 + R() * 0.35) % 1;
    var A = hsl(h1, 0.65, 0.16 + R() * 0.06), Bc = hsl(h2, 0.7, 0.24 + R() * 0.08);
    // звёзды
    for (var i = 0; i < S.stars.length; i++) gl.deleteTexture(S.stars[i]);
    S.stars = [tex(gl, starLayer(R, 900, 0.55, 0.0, 0.25), true), tex(gl, starLayer(R, 260, 0.85, 0.04, 0.3), true), tex(gl, starLayer(R, 70, 1.2, 0.12, 0.35), true)];
    // туманность — в текстуру 1024²
    var N = 1024;
    if (S.neb) gl.deleteTexture(S.neb);
    S.neb = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, S.neb);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, S.neb, 0);
    gl.viewport(0, 0, N, N); gl.useProgram(S.nebProg);
    gl.uniform2f(gl.getUniformLocation(S.nebProg, 'uR'), N, N);
    gl.uniform3f(gl.getUniformLocation(S.nebProg, 'uA'), A[0], A[1], A[2]);
    gl.uniform3f(gl.getUniformLocation(S.nebProg, 'uB'), Bc[0], Bc[1], Bc[2]);
    gl.uniform1f(gl.getUniformLocation(S.nebProg, 'uSeed'), (S.seed % 1000) / 37);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
    // расстановка: планета — у одного из нижних углов (горизонт по диагонали), солнце — напротив, за краем
    var side = R() < 0.5 ? -1 : 1;
    S.place = { side: side, cx: 0.5 + side * (0.12 + R() * 0.22), cap: 0.36 + R() * 0.12, rk: 0.95 + R() * 0.2, el: 0.02 + R() * 0.14,
                sunA: (side > 0 ? Math.PI * 0.75 : Math.PI * 0.25) + (R() - 0.5) * 0.5, tilt: (R() - 0.5) * 0.7, incl: 0.25 + R() * 0.25,
                rot0: R() * 6.283, nebX: R(), nebY: R(), sunC: R() < 0.7 ? [1.0, 0.92, 0.78] : R() < 0.5 ? [1.0, 0.78, 0.55] : [0.78, 0.86, 1.0] };
    // планета системы
    S.planet = pid; S.plReady = false;
    if (S.pl) { gl.deleteTexture(S.pl); S.pl = null; }
    if (pid) {
      var im = new Image(), my = key;
      im.onload = function() {
        if (S.sys !== my || !S.gl) return;
        var c2 = document.createElement('canvas'); c2.width = 1024; c2.height = 512;
        c2.getContext('2d').drawImage(im, 0, 0, 1024, 512);
        S.pl = tex(S.gl, c2, true); S.plReady = true; S.last = 0;
      };
      im.src = '../assets/planets/' + pid + '.png';
    }
  }

  function quality() {
    var G = root.SPGfx; if (!G) return { dpr: 1, motion: true };
    var q = G.Q ? G.Q() : { dpr: 1 }, eco = G.get && G.get('eco');
    var reduce = false; try { reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    return { dpr: Math.min(root.devicePixelRatio || 1, Math.max(0.75, Math.min(1.5, (q.dpr || 1) * 0.75))), motion: !eco && !reduce, eco: !!eco };
  }

  // Кадр: cam — камера боя (x, y в метрах, s — точек на метр), sys — система (id, deep) или null (стенд)
  function draw(cam, sys, opt) {
    if (!init() || S.lost) return;
    var gl = S.gl, Q = quality(), now = performance.now();
    var vw = root.innerWidth, vh = root.innerHeight, dpr = Q.dpr;
    var W = Math.max(1, Math.round(vw * dpr)), H = Math.max(1, Math.round(vh * dpr));
    var resized = false;
    if (S.cv.width !== W || S.cv.height !== H) { S.cv.width = W; S.cv.height = H; S.cv.style.width = vw + 'px'; S.cv.style.height = vh + 'px'; resized = true; }
    setSystem(sys);
    var camKey = Math.round(cam.x) + ',' + Math.round(cam.y) + ',' + cam.s.toFixed(5);
    var moved = camKey !== S.lastCam || resized;
    // не чаще 30 раз в секунду при движении камеры (небо далеко — глазу хватает), в покое — 20 (мерцание, вращение)
    if (!resized && now - S.last < (moved ? (Q.eco ? 66 : 33) : Q.motion ? 50 : 1000)) return;
    if (opt && opt.hidden && !moved && now - S.last < 400) return;     // под интерьером корабля — реже
    S.last = now; S.lastCam = camKey;
    var t = Q.motion ? now / 1000 : 0, P = S.place, u = S.u;
    var km = function(m) { return m / 1000; };
    // зум: ближние слои чуть растут (лог масштаба), дальние почти нет
    var zl = Math.log(Math.max(0.004, cam.s) / 0.03) / Math.LN2, zk = function(k) { return Math.max(0.75, Math.min(1.6, 1 + zl * k)); };
    var cx = km(cam.x - 15000), cy = km(cam.y - 15000);           // от центра орбиты (30 км)
    gl.viewport(0, 0, W, H); gl.useProgram(S.prog);
    gl.uniform2f(u.uR, W, H); gl.uniform1f(u.uT, t % 1000);   // время в шейдере — по кругу: mediump не держит большие числа gl.uniform1f(u.uMo, Q.motion ? 1 : 0);
    // туманность: квадрат 1,5 размера экрана, сдвиг 3 точки/км (y экрана вниз — у GL вверх)
    var NS = Math.max(W, H) * 1.5 * zk(0.02), nx = (W - NS) / 2 + (P.nebX - 0.5) * NS * 0.2 - cx * 3 * dpr, ny = (H - NS) / 2 + (P.nebY - 0.5) * NS * 0.2 + cy * 3 * dpr;
    gl.uniform4f(u.uNebR, nx, ny, NS, NS);
    gl.uniform2f(u.uO0, cx * 6 * dpr, -cy * 6 * dpr); gl.uniform2f(u.uO1, cx * 12 * dpr, -cy * 12 * dpr); gl.uniform2f(u.uO2, cx * 22 * dpr, -cy * 22 * dpr);
    gl.uniform3f(u.uSs, dpr * 1.0 * zk(0.01), dpr * 1.0 * zk(0.03), dpr * 1.0 * zk(0.06));
    // планета
    var on = S.planet && S.plReady ? 1 : 0, D = Math.sqrt(W * W + H * H);
    // планета занимает низ экрана: верх диска — на cap высоты, кривизна — от ширины (телефон стоя и лёжа, компьютер)
    var PR = Math.max(W * 0.62, H * 0.75) * P.rk * zk(0.035), pcx = W * P.cx - cx * 9 * dpr, pcy = H * P.cap - PR + cy * 9 * dpr;
    gl.uniform1f(u.uPOn, on); gl.uniform1f(u.uPR, PR); gl.uniform2f(u.uPC, pcx, pcy);
    gl.uniform1f(u.uRot, P.rot0 + t * 6.2832 / 1800);
    var lk = S.look;
    gl.uniform1f(u.uCl, Q.eco ? lk.cloud * 0.6 : lk.cloud); gl.uniform1f(u.uLava, lk.lava || 0); gl.uniform1f(u.uCity, lk.city || 0);
    gl.uniform3f(u.uAtm, lk.atm[0], lk.atm[1], lk.atm[2]);
    // наклон оси: поворот в плоскости экрана (tilt) и к зрителю (incl)
    var ct = Math.cos(P.tilt), st = Math.sin(P.tilt), ci = Math.cos(P.incl), si = Math.sin(P.incl);
    gl.uniformMatrix3fv(u.uPM, false, new Float32Array([ct, ci * st, si * st, -st, ci * ct, si * ct, 0, -si, ci]));
    // солнце: за краем экрана со стороны, противоположной планете; свет на планету — оттуда же
    var sa = P.sunA, sx = W * 0.5 + Math.cos(sa) * D * 0.36 - cx * 1.2 * dpr, sy = H * 0.5 + Math.sin(sa) * D * 0.36 + cy * 1.2 * dpr;
    // свет почти сбоку: по видимой части планеты идёт терминатор, ночная сторона — с огнями городов
    var lx = sx - pcx, ly = sy - pcy, ll = Math.sqrt(lx * lx + ly * ly) || 1, el = P.el;
    gl.uniform3f(u.uL, lx / ll * Math.cos(el), ly / ll * Math.cos(el), Math.sin(el));
    gl.uniform2f(u.uSun, sx, sy); gl.uniform3f(u.uSunC, P.sunC[0], P.sunC[1], P.sunC[2]);
    // солнце за планетой — гаснет
    var sdP = Math.sqrt((sx - pcx) * (sx - pcx) + (sy - pcy) * (sy - pcy)) / PR;
    gl.uniform1f(u.uSunK, on ? Math.max(0, Math.min(1, (sdP - 1) * 12)) : 1);
    // текстуры
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, S.neb); gl.uniform1i(u.uNeb, 0);
    for (var i = 0; i < 3; i++) { gl.activeTexture(gl.TEXTURE1 + i); gl.bindTexture(gl.TEXTURE_2D, S.stars[i]); }
    gl.uniform1i(u.uS0, 1); gl.uniform1i(u.uS1, 2); gl.uniform1i(u.uS2, 3);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, S.pl || S.neb); gl.uniform1i(u.uPl, 4);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  root.SPSky = { draw: draw, LOOK: LOOK, ok: function() { return !!S.gl; } };
})(typeof self !== 'undefined' ? self : this);
