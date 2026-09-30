/* ============================================================
 * 森林网 · 自托管拼图验证码（多缺口滑块）
 * 验证过程完全走本站 /api/captcha/*，不依赖任何第三方服务。
 *
 * 一道题随机 2~3 块拼图，每块在自己的高度上，用户依次拖动滑块把它送到缺口里；
 * 全部对位后一次性提交，服务端逐块核对位置与拖动轨迹，通过后签发一次性 ticket。
 *
 * 用法一（页面内直接放容器）：
 *   <div class="forest-captcha" data-forest-captcha data-action="login"></div>
 *   <script src="/captcha.js?v=1.9.2"></script>
 *   const captcha = window.ForestCaptcha.get(document.querySelector('[data-forest-captcha]'));
 *   captcha.ticket();   // 未通过时返回空字符串
 *
 * 用法二（动态挂载，如反馈弹窗）：
 *   const instance = window.ForestCaptcha.mount(containerEl, { action: 'feedback' });
 *
 * ticket 一次性有效，提交表单时作为 captchaToken 传给后端；换新题请调用 reset()。
 * ============================================================ */
(() => {
  if (window.ForestCaptcha) return;

  const SCRIPT_VERSION = '1.9.3';
  const STYLE_ID = 'forest-captcha-style';

  const CSS = `
.forest-captcha{width:100%;max-width:330px;margin:16px auto 0;font-family:system-ui,"Microsoft YaHei",sans-serif}
.fc-stage{position:relative;width:100%;aspect-ratio:16/9;border:1px solid #bde3a544;border-radius:10px;background:#0b2417;overflow:hidden;-webkit-user-select:none;user-select:none}
.fc-stage img{position:absolute;display:block;pointer-events:none;-webkit-user-drag:none;user-select:none}
.fc-bg{left:0;top:0;width:100%;height:100%}
.fc-piece{left:0;top:0;opacity:.62;transition:opacity .15s ease}
.fc-piece.is-active{opacity:1;filter:drop-shadow(0 0 7px rgba(169,216,117,.6))}
.fc-piece.is-locked{opacity:1;filter:drop-shadow(0 2px 6px rgba(0,0,0,.45))}
.fc-loading{position:absolute;inset:0;display:none;place-items:center;color:#a8c3a4;font-size:12.5px;background:rgba(8,26,18,.72)}
.fc-stage.is-loading .fc-loading{display:grid}
.fc-refresh{position:absolute;right:6px;top:6px;width:26px;height:26px;padding:0;border:1px solid #bde3a566;border-radius:50%;background:rgba(7,25,17,.74);color:#dbeed0;font-size:13px;line-height:1;cursor:pointer;display:grid;place-items:center}
.fc-refresh:hover{background:rgba(169,216,117,.24)}
.fc-track{position:relative;height:42px;margin-top:10px;border:1px solid #bde3a544;border-radius:10px;background:#071910;overflow:hidden;touch-action:none;-webkit-tap-highlight-color:transparent}
.fc-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:linear-gradient(90deg,rgba(47,107,66,.9),rgba(169,216,117,.75))}
.fc-status{position:absolute;inset:0;display:grid;place-items:center;padding:0 60px;color:#9db7a1;font-size:12.5px;text-align:center;pointer-events:none}
.fc-handle{position:absolute;left:0;top:2px;width:52px;height:36px;display:grid;place-items:center;border-radius:8px;background:#a9d875;color:#17321d;font-size:18px;font-weight:700;cursor:grab;box-shadow:0 3px 10px rgba(0,0,0,.35)}
.forest-captcha[data-state="dragging"] .fc-handle,.forest-captcha[data-state="solved"] .fc-handle{cursor:default}
.forest-captcha[data-state="solved"] .fc-handle{background:#7fc45a}
.forest-captcha[data-state="error"] .fc-handle{background:#d98a70;color:#2b1008}
/* 固定高度：拖完一块清空提示时不能让整块区域高度变化，否则滑块位置会在拖动过程中跳动 */
.fc-message{margin:7px 2px 0;color:#87a28b;font-size:11.5px;line-height:1.5;text-align:center;min-height:34px}
.fc-message[data-kind="error"]{color:#ffb4a8}
.fc-message[data-kind="ok"]{color:#c8ec9d}
`;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  class SliderCaptcha {
    constructor(el, options = {}) {
      this.el = el;
      this.action = options.action || el.dataset.action || 'default';
      this.challenge = null;
      this.ticketValue = '';
      this.solved = false;
      this.busy = false;
      this.dragging = false;
      this.dragX = 0;
      this.active = 0;
      this.placed = [];
      this.pieceEls = [];
      this.pointerOffset = 0;
      this.trackPoints = [];
      this.startTime = 0;
      this.metrics = { stageW: 0, scale: 1, travel: 1, pieceTravel: 0 };
      this.build();
      this.bind();
      this.load();
    }

    get pieceCount() {
      return this.challenge?.pieces?.length || 0;
    }

    build() {
      ensureStyle();
      this.el.classList.add('forest-captcha');
      this.el.dataset.state = 'loading';
      this.el.innerHTML = `
        <div class="fc-stage is-loading">
          <img class="fc-bg" alt="" draggable="false">
          <div class="fc-loading">正在加载图形…</div>
          <button class="fc-refresh" type="button" title="换一题" aria-label="换一题">↻</button>
        </div>
        <div class="fc-track" role="slider" aria-label="拖动滑块把拼图送进缺口" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
          <div class="fc-fill"></div>
          <span class="fc-status">正在准备人机验证…</span>
          <div class="fc-handle">→</div>
        </div>
        <p class="fc-message" role="status" aria-live="polite"></p>`;
      this.stage = this.el.querySelector('.fc-stage');
      this.bg = this.el.querySelector('.fc-bg');
      this.track = this.el.querySelector('.fc-track');
      this.fill = this.el.querySelector('.fc-fill');
      this.status = this.el.querySelector('.fc-status');
      this.handle = this.el.querySelector('.fc-handle');
      this.message = this.el.querySelector('.fc-message');
    }

    bind() {
      this.onDown = (event) => this.pointerDown(event);
      this.onMove = (event) => this.pointerMove(event);
      this.onUp = (event) => this.pointerUp(event);
      this.track.addEventListener('pointerdown', this.onDown);
      this.track.addEventListener('pointermove', this.onMove);
      this.track.addEventListener('pointerup', this.onUp);
      this.track.addEventListener('pointercancel', this.onUp);
      // 键盘也能操作，方便无鼠标设备：方向键移动，回车放下当前块（放完即提交）
      this.track.addEventListener('keydown', (event) => {
        if (this.solved || !this.challenge || this.busy) return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          this.measure();
          if (!this.trackPoints.length) {
            this.startTime = performance.now();
            this.trackPoints = [{ x: Number(this.logicalX().toFixed(2)), t: 0 }];
          }
          const step = (event.shiftKey ? 20 : 6) * this.metrics.travel / this.metrics.stageW;
          this.dragX = Math.max(0, Math.min(this.dragX + (event.key === 'ArrowRight' ? step : -step), this.metrics.travel));
          this.paint();
          this.record();
          this.track.dataset.keyboard = '1';
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          this.placeCurrent();
        }
      });
      this.el.querySelector('.fc-refresh').addEventListener('click', () => this.load());
      this.resizeHandler = () => {
        if (this.pending) {
          if (this.stage.clientWidth) this.load();
          return;
        }
        if (!this.challenge) return;
        this.measure();
        this.paint();
      };
      window.addEventListener('resize', this.resizeHandler);
    }

    destroy() {
      window.removeEventListener('resize', this.resizeHandler);
      this.track.removeEventListener('pointerdown', this.onDown);
      this.track.removeEventListener('pointermove', this.onMove);
      this.track.removeEventListener('pointerup', this.onUp);
      this.track.removeEventListener('pointercancel', this.onUp);
    }

    setMessage(text, kind = '') {
      this.message.textContent = text || '';
      this.message.dataset.kind = kind;
    }

    updateStatus() {
      if (this.solved) {
        this.status.textContent = '拼图已对位';
        return;
      }
      this.status.textContent = this.pieceCount > 1
        ? `第 ${Math.min(this.active + 1, this.pieceCount)}/${this.pieceCount} 块 · 拖动滑块补齐拼图`
        : '拖动滑块，把拼图放进大小匹配的缺口';
    }

    measure() {
      const stageW = this.stage.clientWidth || this.el.clientWidth || 0;
      const first = this.challenge?.pieces?.[0];
      const scale = first ? stageW / this.challenge.w : 1;
      this.metrics = {
        stageW,
        scale,
        travel: Math.max(1, this.track.clientWidth - this.handle.offsetWidth),
        pieceTravel: first ? Math.max(0, stageW - first.w * scale) : 0
      };
    }

    logicalX() {
      const { travel, pieceTravel, scale } = this.metrics;
      if (!scale) return 0;
      return (this.dragX / travel) * pieceTravel / scale;
    }

    toStageLeft(dragX) {
      const { travel, pieceTravel } = this.metrics;
      return (dragX / travel) * pieceTravel;
    }

    paint() {
      if (!this.challenge) return;
      const { scale } = this.metrics;
      this.challenge.pieces.forEach((piece, index) => {
        const el = this.pieceEls[index];
        if (!el) return;
        const place = this.placed[index];
        const dragX = place ? place.dragX : (index === this.active ? this.dragX : 0);
        el.style.width = `${(piece.w * scale).toFixed(2)}px`;
        el.style.height = `${(piece.h * scale).toFixed(2)}px`;
        el.style.left = `${this.toStageLeft(dragX).toFixed(2)}px`;
        el.style.top = `${(piece.y * scale).toFixed(2)}px`;
        el.classList.toggle('is-locked', Boolean(place));
        el.classList.toggle('is-active', !place && index === this.active && !this.solved);
      });
      const allPlaced = this.placed.length === this.pieceCount && this.placed.every(Boolean);
      const shownX = allPlaced ? this.metrics.travel : this.dragX;
      this.fill.style.width = `${shownX.toFixed(2)}px`;
      this.handle.style.left = `${shownX.toFixed(2)}px`;
      this.track.setAttribute('aria-valuenow', String(Math.round((shownX / this.metrics.travel) * 100)));
    }

    resetHandle() {
      this.dragX = 0;
      this.trackPoints = [];
      this.placed = new Array(this.pieceCount).fill(null);
      this.active = 0;
      this.paint();
      this.updateStatus();
    }

    record() {
      if (!this.dragging && !this.track.dataset.keyboard) return;
      const t = Math.round(performance.now() - this.startTime);
      const x = this.logicalX();
      const last = this.trackPoints[this.trackPoints.length - 1];
      if (last && Math.abs(last.x - x) < 0.5) return;
      this.trackPoints.push({ x: Number(x.toFixed(2)), t });
    }

    pointerDown(event) {
      if (this.busy || this.solved || !this.challenge || this.active >= this.pieceCount) return;
      event.preventDefault();
      this.measure();
      delete this.track.dataset.keyboard;
      this.dragging = true;
      this.pointerOffset = event.clientX - this.track.getBoundingClientRect().left - this.dragX;
      this.startTime = performance.now();
      this.trackPoints = [{ x: Number(this.logicalX().toFixed(2)), t: 0 }];
      this.setMessage('');
      this.updateStatus();
      this.el.dataset.state = 'dragging';
      try { this.track.setPointerCapture(event.pointerId); } catch (error) { /* 部分浏览器不支持 */ }
    }

    pointerMove(event) {
      if (!this.dragging) return;
      event.preventDefault();
      const left = this.track.getBoundingClientRect().left;
      const next = event.clientX - left - this.pointerOffset;
      this.dragX = Math.max(0, Math.min(next, this.metrics.travel));
      this.paint();
      this.record();
    }

    pointerUp(event) {
      if (!this.dragging) return;
      this.pointerMove(event);
      this.dragging = false;
      try { this.track.releasePointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
      this.placeCurrent();
    }

    // 放下当前这块：记录位置与轨迹，接着换下一块；全部放完就提交
    placeCurrent() {
      if (!this.challenge || this.solved || this.busy) return;
      if (this.active >= this.pieceCount) return;
      if (!this.trackPoints.length || this.dragX < 2) {
        this.trackPoints = [];
        this.dragX = 0;
        delete this.track.dataset.keyboard;
        this.paint();
        this.setMessage('请把拼图块拖到缺口里', 'error');
        return;
      }
      this.placed[this.active] = {
        dragX: this.dragX,
        x: Number(this.logicalX().toFixed(2)),
        track: this.trackPoints.slice()
      };
      delete this.track.dataset.keyboard;
      this.trackPoints = [];
      this.dragX = 0;
      this.setMessage('');
      if (this.active < this.pieceCount - 1) {
        this.active += 1;
        this.el.dataset.state = 'ready';
        this.paint();
        this.updateStatus();
        return;
      }
      this.paint();
      this.finish();
    }

    async finish() {
      if (!this.challenge || this.solved || this.busy) return;
      if (this.placed.length !== this.pieceCount || !this.placed.every(Boolean)) {
        this.setMessage('还有拼图没放好', 'error');
        return;
      }
      this.busy = true;
      this.el.dataset.state = 'dragging';
      this.setMessage('正在校验…');
      try {
        const response = await fetch('/api/captcha/verify', {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ForestCaptcha' },
          body: JSON.stringify({
            id: this.challenge.id,
            placements: this.placed.map((place) => ({ x: place.x, track: place.track }))
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          this.setMessage(data.error || '验证失败，请重试', 'error');
          if (data.expired) {
            this.status.textContent = '验证已失效';
            this.el.dataset.state = 'error';
            this.load();
            return;
          }
          this.resetHandle();
          this.el.dataset.state = 'error';
          return;
        }
        this.ticketValue = data.ticket || '';
        this.solved = true;
        this.el.dataset.state = 'solved';
        this.handle.textContent = '✓';
        this.updateStatus();
        this.paint();
        this.setMessage('验证通过，可以提交了', 'ok');
        this.el.dispatchEvent(new CustomEvent('forest-captcha-solved', { bubbles: true, detail: { ticket: this.ticketValue } }));
      } catch (error) {
        this.setMessage('网络异常，请重新拖动一次', 'error');
        this.resetHandle();
        this.el.dataset.state = 'error';
      } finally {
        this.busy = false;
      }
    }

    ticket() {
      return this.solved ? this.ticketValue : '';
    }

    async load() {
      if (this.busy) return;
      this.ticketValue = '';
      this.solved = false;
      this.challenge = null;
      this.placed = [];
      this.pieceEls.forEach((el) => el.remove());
      this.pieceEls = [];
      this.active = 0;
      this.dragX = 0;
      this.trackPoints = [];
      this.handle.textContent = '→';
      this.el.dataset.state = 'loading';
      this.stage.classList.add('is-loading');
      this.status.textContent = '正在准备人机验证…';
      this.setMessage('');
      // 容器还没显示（例如藏在未打开的弹窗里）时不发请求，等容器可见后再加载
      if (!this.stage.clientWidth) {
        this.pending = true;
        this.stage.classList.remove('is-loading');
        this.el.dataset.state = 'ready';
        this.updateStatus();
        return;
      }
      this.pending = false;
      this.busy = true;
      try {
        const response = await fetch(`/api/captcha/new?_=${Date.now()}`, { credentials: 'include', cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.bg || !Array.isArray(data.pieces) || !data.pieces.length) {
          throw new Error(data.error || '人机验证加载失败');
        }
        this.challenge = data;
        this.bg.src = data.bg;
        this.placed = new Array(data.pieces.length).fill(null);
        data.pieces.forEach((piece) => {
          const img = document.createElement('img');
          img.className = 'fc-piece';
          img.alt = '';
          img.draggable = false;
          img.src = piece.image;
          this.stage.insertBefore(img, this.stage.querySelector('.fc-loading'));
          this.pieceEls.push(img);
        });
        this.stage.classList.remove('is-loading');
        this.el.dataset.state = 'ready';
        this.measure();
        this.paint();
        this.updateStatus();
        this.setMessage(this.pieceCount > 1 ? '把左边的拼图块依次拖到缺口上' : '背景上有几个缺口，只有大小匹配的那个能放下拼图');
      } catch (error) {
        this.stage.classList.remove('is-loading');
        this.el.dataset.state = 'error';
        this.status.textContent = '加载失败，点右上角刷新';
        this.setMessage(error.message || '人机验证加载失败，请点击刷新重试', 'error');
      } finally {
        this.busy = false;
      }
    }

    reset() {
      return this.load();
    }
  }

  function mount(el, options = {}) {
    if (!el) return null;
    if (el.__forestCaptcha) return el.__forestCaptcha;
    const instance = new SliderCaptcha(el, options);
    el.__forestCaptcha = instance;
    return instance;
  }

  function autoMount() {
    document.querySelectorAll('[data-forest-captcha]').forEach((el) => mount(el));
  }

  window.ForestCaptcha = {
    version: SCRIPT_VERSION,
    mount,
    get(el) {
      if (!el) return null;
      // 页面内联脚本可能早于自动挂载执行，这里按需补挂载
      if (!el.__forestCaptcha && el.hasAttribute('data-forest-captcha')) return mount(el);
      return el.__forestCaptcha || null;
    },
    ticket(el) {
      const instance = this.get(el);
      return instance ? instance.ticket() : '';
    },
    reset(el) {
      const instance = this.get(el);
      if (instance) instance.reset();
    },
    resetAll(root = document) {
      root.querySelectorAll('[data-forest-captcha]').forEach((el) => this.reset(el));
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount, { once: true });
  } else {
    autoMount();
  }
})();
