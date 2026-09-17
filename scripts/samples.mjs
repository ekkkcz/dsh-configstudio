/**
 * 六类固定示例作品（对应 A13：落地页 / 仪表盘 / 动画 / 可视化 / 交互原型 / 小游戏）。
 *
 * 这些是**固定测试样本**，不是真实模型输出，必须与真实模型结果分开记录。
 * 全部单文件、离线可用、无外部依赖，用来验证预览隔离与可操作性。
 */

const HEAD = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">';

/** 1) 落地页 */
const landing = HEAD + '<title>Aurora · 落地页</title><style>'
  + '*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;'
  + 'background:#0b1020;color:#e8ecf6}header{padding:56px 32px;text-align:center;'
  + 'background:radial-gradient(120% 120% at 50% 0%,#1b2a6b 0%,#0b1020 60%)}'
  + 'h1{margin:0 0 12px;font-size:44px;letter-spacing:-.02em}p.sub{margin:0 auto;max-width:620px;color:#9fb0d0}'
  + '.cta{display:inline-block;margin-top:24px;padding:12px 26px;border-radius:999px;border:0;'
  + 'background:linear-gradient(135deg,#5b8cff,#a05bff);color:#fff;font-size:16px;cursor:pointer}'
  + '.cta:hover{filter:brightness(1.12)}.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));'
  + 'padding:40px 32px;max-width:1000px;margin:0 auto}.card{background:#141a30;border:1px solid #23304f;'
  + 'border-radius:14px;padding:20px}.card h3{margin:0 0 8px;font-size:17px}.card p{margin:0;color:#93a3c2;font-size:14px}'
  + 'footer{padding:28px;text-align:center;color:#66779a;font-size:13px}'
  + '</style></head><body>'
  + '<header><h1>Aurora</h1><p class="sub">把想法变成页面。一个按钮切换主题，一个输入框立刻反馈。</p>'
  + '<button class="cta" id="go">试试看</button></header>'
  + '<section class="grid"><div class="card"><h3>离线可用</h3><p>不依赖任何外部资源。</p></div>'
  + '<div class="card"><h3>响应式</h3><p>窄屏自动换成单列。</p></div>'
  + '<div class="card"><h3>可交互</h3><p>主题与计数器都有真实状态。</p></div></section>'
  + '<footer>示例作品 · 由 HTML Arena 提供</footer>'
  + '<script>var dark=true;document.getElementById("go").addEventListener("click",function(){'
  + 'dark=!dark;document.body.style.background=dark?"#0b1020":"#f4f6fb";document.body.style.color=dark?"#e8ecf6":"#131a2b";'
  + '});</script></body></html>';

/** 2) 天气仪表盘（PRD 的示例题） */
const dashboard = HEAD + '<title>天气仪表盘</title><style>'
  + 'body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}'
  + '.bar{display:flex;gap:10px;align-items:center;margin-bottom:18px;flex-wrap:wrap}'
  + 'select,button{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:7px 12px;font:inherit}'
  + 'button{cursor:pointer}.wrap{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}'
  + '.panel{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:18px}'
  + '.big{font-size:52px;font-weight:600;margin:6px 0}.muted{color:#94a3b8;font-size:13px}'
  + 'canvas{width:100%;height:180px;display:block}svg{width:100%;height:180px}'
  + 'body.day{background:#eff6ff;color:#0f172a}body.day .panel{background:#fff;border-color:#dbeafe}'
  + 'body.day .muted{color:#64748b}body.day select,body.day button{background:#fff;color:#0f172a;border-color:#cbd5e1}'
  + '</style></head><body>'
  + '<div class="bar"><strong>天气仪表盘</strong>'
  + '<select id="city"><option value="beijing">北京</option><option value="shanghai">上海</option>'
  + '<option value="shenzhen">深圳</option></select>'
  + '<input type="date" id="date" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:6px 10px">'
  + '<button id="theme">切换昼夜</button><span class="muted" id="stamp"></span></div>'
  + '<div class="wrap"><div class="panel"><div class="muted">当前温度</div>'
  + '<div class="big" id="temp">--</div><div class="muted" id="cond">--</div></div>'
  + '<div class="panel"><div class="muted">24 小时趋势</div><svg id="chart" viewBox="0 0 320 180" preserveAspectRatio="none"></svg></div>'
  + '<div class="panel"><div class="muted">湿度 / 风速</div><div id="extra" style="margin-top:10px"></div></div>'
  + '</div><script>'
  + 'var DATA={beijing:{n:"北京",t:[2,1,0,-1,0,3,7,11,14,16,17,16,14,11,8,6,5,4,3,2,1,1,2,3],c:"晴",h:38,w:12},'
  + 'shanghai:{n:"上海",t:[8,8,7,7,8,10,13,16,19,21,22,22,21,19,17,15,13,12,11,11,10,10,9,9],c:"多云",h:64,w:18},'
  + 'shenzhen:{n:"深圳",t:[18,18,17,17,18,20,23,26,28,29,30,30,29,28,27,26,25,24,24,23,23,22,22,22],c:"阵雨",h:78,w:22}};'
  + 'function draw(k){var d=DATA[k],maps=d.t,min=Math.min.apply(null,maps),max=Math.max.apply(null,maps);'
  + 'var pts=maps.map(function(v,i){var x=i*(320/23);var y=160-((v-min)/((max-min)||1))*130;return x.toFixed(1)+","+y.toFixed(1)});'
  + 'document.getElementById("chart").innerHTML="<polyline fill=\\"none\\" stroke=\\"#60a5fa\\" stroke-width=\\"3\\" points=\\""+pts.join(" ")+"\\"/>"'
  + '+"<polyline fill=\\"rgba(96,165,250,.18)\\" stroke=\\"none\\" points=\\"0,170 "+pts.join(" ")+" 320,170\\"/>";'
  + 'document.getElementById("temp").textContent=maps[12]+"°C";document.getElementById("cond").textContent=d.c;'
  + 'document.getElementById("extra").innerHTML="<div>湿度 "+d.h+"%</div><div>风速 "+d.w+" km/h</div>";}'
  + 'function upd(){var k=document.getElementById("city").value;draw(k);'
  + 'document.getElementById("stamp").textContent=document.getElementById("date").value+" · 内置示例数据";}'
  + 'document.getElementById("city").addEventListener("change",upd);'
  + 'document.getElementById("date").addEventListener("change",upd);'
  + 'document.getElementById("theme").addEventListener("click",function(){document.body.classList.toggle("day");});'
  + 'document.getElementById("date").value=new Date().toISOString().slice(0,10);upd();'
  + '</script></body></html>';

/** 3) CSS / Canvas 动画 */
const animation = HEAD + '<title>粒子动画</title><style>'
  + 'body{margin:0;background:#05060a;color:#cbd5e1;font:14px system-ui;overflow:hidden}'
  + 'canvas{display:block;width:100vw;height:100vh}'
  + '.hud{position:fixed;left:16px;bottom:16px;background:rgba(15,23,42,.72);border:1px solid #334155;'
  + 'border-radius:10px;padding:10px 14px;backdrop-filter:blur(6px)}button{background:#1e293b;color:#e2e8f0;'
  + 'border:1px solid #334155;border-radius:8px;padding:5px 10px;cursor:pointer;font:inherit;margin-left:8px}'
  + '</style></head><body><canvas id="c"></canvas><div class="hud">粒子 <b id="n">0</b> · FPS <b id="f">0</b>'
  + '<button id="reset">重置</button></div><script>'
  + 'var c=document.getElementById("c"),x=c.getContext("2d"),ps=[],W,H;'
  + 'function size(){W=c.width=innerWidth;H=c.height=innerHeight}size();addEventListener("resize",size);'
  + 'function seed(n){ps=[];for(var i=0;i<n;i++)ps.push({x:Math.random()*W,y:Math.random()*H,'
  + 'vx:(Math.random()-.5)*1.6,vy:(Math.random()-.5)*1.6,r:Math.random()*2.4+.6});'
  + 'document.getElementById("n").textContent=n}seed(220);'
  + 'document.getElementById("reset").addEventListener("click",function(){seed(220)});'
  + 'var last=performance.now(),frames=0,acc=0;'
  + 'function loop(t){var dt=Math.min(32,t-last);last=t;acc+=dt;frames++;'
  + 'if(acc>500){document.getElementById("f").textContent=Math.round(frames*1000/acc);frames=0;acc=0}'
  + 'x.fillStyle="rgba(5,6,10,.28)";x.fillRect(0,0,W,H);'
  + 'for(var i=0;i<ps.length;i++){var p=ps[i];p.x+=p.vx;p.y+=p.vy;'
  + 'if(p.x<0||p.x>W)p.vx*=-1;if(p.y<0||p.y>H)p.vy*=-1;'
  + 'x.beginPath();x.arc(p.x,p.y,p.r,0,6.2832);x.fillStyle="hsl("+((i*3)%360)+",85%,68%)";x.fill()}'
  + 'requestAnimationFrame(loop)}requestAnimationFrame(loop);'
  + '</script></body></html>';

/** 4) 数据可视化（纯 SVG，无依赖） */
const dataviz = HEAD + '<title>数据可视化</title><style>'
  + 'body{margin:0;font:15px system-ui;background:#f8fafc;color:#0f172a;padding:28px}'
  + 'h1{font-size:20px;margin:0 0 4px}.muted{color:#64748b;font-size:13px;margin-bottom:20px}'
  + 'svg{width:100%;max-width:760px;background:#fff;border:1px solid #e2e8f0;border-radius:12px}'
  + '.bar{fill:#3b82f6;transition:fill .15s}.bar:hover{fill:#1d4ed8}text{font:12px system-ui;fill:#475569}'
  + '.legend{display:flex;gap:18px;margin-top:14px;font-size:13px;color:#475569}'
  + '.dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle}'
  + '</style></head><body><h1>各类作品的生成量</h1><div class="muted">悬停柱子看具体数值 · 纯 SVG，无外部依赖</div>'
  + '<svg id="s" viewBox="0 0 760 300"></svg>'
  + '<div class="legend"><span><i class="dot" style="background:#3b82f6"></i>生成量</span>'
  + '<span><i class="dot" style="background:#93c5fd"></i>其中一次通过</span></div><script>'
  + 'var D=[{n:"落地页",v:42,p:31},{n:"仪表盘",v:35,p:22},{n:"动画",v:28,p:19},'
  + '{n:"可视化",v:31,p:24},{n:"交互原型",v:26,p:20},{n:"小游戏",v:19,p:11}];'
  + 'var max=Math.max.apply(null,D.map(function(d){return d.v})),pad=48,bw=(760-pad*2)/D.length;'
  + 'var h="";D.forEach(function(d,i){var bh=(d.v/max)*180,x=pad+i*bw+14,w=bw-28;'
  + 'h+="<rect class=\\"bar\\" x=\\""+x+"\\" y=\\""+(240-bh)+"\\" width=\\""+w+"\\" height=\\""+bh+"\\" rx=\\"4\\">'
  + '<title>"+d.n+"：生成 "+d.v+"，一次通过 "+d.p+"</title></rect>";'
  + 'h+="<rect x=\\""+x+"\\" y=\\""+(240-(d.p/max)*180)+"\\" width=\\""+w+"\\" height=\\""+((d.p/max)*180)+"\\" rx=\\"4\\" fill=\\"#93c5fd\\"/>";'
  + 'h+="<text x=\\""+(x+w/2)+"\\" y=\\"262\\" text-anchor=\\"middle\\">"+d.n+"</text>";'
  + 'h+="<text x=\\""+(x+w/2)+"\\" y=\\""+(232-bh)+"\\" text-anchor=\\"middle\\">"+d.v+"</text>"});'
  + 'h+="<line x1=\\""+pad+"\\" y1=\\"240\\" x2=\\"712\\" y2=\\"240\\" stroke=\\"#cbd5e1\\"/>";'
  + 'document.getElementById("s").innerHTML=h;</script></body></html>';

/** 5) 交互原型（可点击的移动端流程） */
const prototype = HEAD + '<title>交互原型</title><style>'
  + 'body{margin:0;font:15px system-ui;background:#e2e8f0;display:grid;place-items:center;min-height:100vh}'
  + '.phone{width:340px;height:640px;background:#fff;border-radius:28px;box-shadow:0 24px 60px rgba(15,23,42,.24);'
  + 'display:flex;flex-direction:column;overflow:hidden}'
  + '.top{padding:16px 20px;border-bottom:1px solid #e2e8f0;font-weight:600;display:flex;justify-content:space-between;align-items:center}'
  + '.body{flex:1;padding:20px;overflow:auto}.row{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f1f5f9}'
  + '.btn{display:block;width:100%;margin-top:16px;padding:13px;border:0;border-radius:12px;background:#2563eb;color:#fff;'
  + 'font:inherit;font-weight:600;cursor:pointer}.btn.ghost{background:#f1f5f9;color:#0f172a}'
  + '.step{color:#64748b;font-size:12px}.hide{display:none}'
  + '</style></head><body><div class="phone"><div class="top"><span id="title">选择方案</span>'
  + '<span class="step" id="step">1 / 3</span></div><div class="body" id="view"></div></div><script>'
  + 'var steps=[{t:"选择方案",h:"<div class=row><span>标准版</span><b>￥ 0</b></div><div class=row><span>专业版</span><b>￥ 49</b></div>",'
  + 'b:[["选专业版",1],["选标准版",1]]},{t:"确认信息",'
  + 'h:"<div class=row><span>方案</span><b id=plan>专业版</b></div><div class=row><span>周期</span><b>每月</b></div>",'
  + 'b:[["下一步",2],["返回",0]]},{t:"完成",h:"<p>已创建。这是原型的最后一步，点返回可以重新走一遍。</p>",b:[["重新开始",0]]}];'
  + 'var i=0;function render(){var s=steps[i];document.getElementById("title").textContent=s.t;'
  + 'document.getElementById("step").textContent=(i+1)+" / 3";'
  + 'var html=s.h;s.b.forEach(function(b,k){html+="<button class=\\"btn"+(k?" ghost":"")+"\\" data-go=\\""+b[1]+"\\">"+b[0]+"</button>"});'
  + 'document.getElementById("view").innerHTML=html;'
  + 'Array.prototype.forEach.call(document.querySelectorAll("[data-go]"),function(el){'
  + 'el.addEventListener("click",function(){i=Number(el.getAttribute("data-go"));render()})})}render();'
  + '</script></body></html>';

/** 6) 浏览器小游戏 */
const game = HEAD + '<title>接方块</title><style>'
  + 'body{margin:0;background:#0f172a;color:#e2e8f0;font:14px system-ui;display:grid;place-items:center;min-height:100vh}'
  + 'canvas{background:#111c33;border:1px solid #334155;border-radius:12px;touch-action:none}'
  + '.hud{display:flex;gap:20px;margin-bottom:12px;align-items:center}'
  + 'button{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:7px 14px;'
  + 'font:inherit;cursor:pointer}'
  + '</style></head><body><div><div class="hud"><span>得分 <b id="s">0</b></span><span>生命 <b id="l">3</b></span>'
  + '<button id="r">重新开始</button></div><canvas id="c" width="420" height="520"></canvas>'
  + '<div class="hud" style="margin-top:10px;font-size:12px;color:#94a3b8">左右方向键或移动鼠标控制挡板</div></div><script>'
  + 'var c=document.getElementById("c"),x=c.getContext("2d");var W=420,H=520;'
  + 'var pad={x:170,w:80,h:12},ball={x:210,y:120,r:7,vx:2.6,vy:2.6},score=0,lives=3,over=false;'
  + 'var keys={};addEventListener("keydown",function(e){keys[e.key]=1});addEventListener("keyup",function(e){keys[e.key]=0});'
  + 'c.addEventListener("mousemove",function(e){var r=c.getBoundingClientRect();pad.x=(e.clientX-r.left)*(W/r.width)-pad.w/2});'
  + 'function reset(){score=0;lives=3;over=false;ball={x:210,y:120,r:7,vx:2.6,vy:2.6};sync()}'
  + 'function sync(){document.getElementById("s").textContent=score;document.getElementById("l").textContent=lives}'
  + 'document.getElementById("r").addEventListener("click",reset);'
  + 'function loop(){if(!over){if(keys.ArrowLeft)pad.x-=6;if(keys.ArrowRight)pad.x+=6;'
  + 'pad.x=Math.max(0,Math.min(W-pad.w,pad.x));'
  + 'ball.x+=ball.vx;ball.y+=ball.vy;'
  + 'if(ball.x<ball.r||ball.x>W-ball.r)ball.vx*=-1;'
  + 'if(ball.y<ball.r)ball.vy*=-1;'
  + 'if(ball.y>H-40-ball.r&&ball.y<H-40+pad.h&&ball.x>pad.x&&ball.x<pad.x+pad.w){ball.vy=-Math.abs(ball.vy);score++;sync()}'
  + 'if(ball.y>H){lives--;sync();if(lives<=0){over=true}else{ball.x=210;ball.y=120;ball.vx=2.6*(Math.random()<.5?-1:1);ball.vy=2.6}}}'
  + 'x.clearRect(0,0,W,H);x.fillStyle="#334155";x.fillRect(0,H-40,W,1);'
  + 'x.fillStyle="#60a5fa";x.fillRect(pad.x,H-40,pad.w,pad.h);'
  + 'x.beginPath();x.arc(ball.x,ball.y,ball.r,0,6.2832);x.fillStyle="#f472b6";x.fill();'
  + 'if(over){x.fillStyle="rgba(15,23,42,.82)";x.fillRect(0,0,W,H);x.fillStyle="#e2e8f0";'
  + 'x.font="600 22px system-ui";x.textAlign="center";x.fillText("得分 "+score,210,250);'
  + 'x.font="14px system-ui";x.fillText("点重新开始再来一局",210,284)}'
  + 'requestAnimationFrame(loop)}loop();'
  + '</script></body></html>';

/** 用来验证"多块需要用户选择"的第二个 HTML（A12）。 */
const altLanding = landing.replace('Aurora', 'Aurora（备选版）').replace('#5b8cff,#a05bff', '#22c55e,#0ea5e9');

export const SAMPLES = { landing, dashboard, animation, dataviz, prototype, game, altLanding };

/** 供 A13 使用：六类样例的清单。 */
export const SAMPLE_CATALOG = [
  { key: 'landing', label: '落地页' },
  { key: 'dashboard', label: '仪表盘' },
  { key: 'animation', label: '动画' },
  { key: 'dataviz', label: '数据可视化' },
  { key: 'prototype', label: '交互原型' },
  { key: 'game', label: '小游戏' },
];
