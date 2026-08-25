// js/trade-share.js
// Phase 4 — branded social share image generation for a confirmed trade.
// Exposes window.TradeShare.renderShareSlot(container, trade, postCache),
// called by trade-zone.js once a trade's confirmed_at is set.
//
// Consent (share_consent_a/b) and the generated image URL are both
// written through the RPCs in the Trade Zone migration
// (set_trade_share_consent / set_trade_share_image) rather than direct
// table writes — trades has no client-facing UPDATE policy at all, see
// the migration's RLS section for why.

(function () {
  const CANVAS_W = 1080;
  const CANVAS_H = 1920;

  async function renderShareSlot(container, trade, postCache) {
    const isParty = trade.trader_a_id === TZ.trader.id || trade.trader_b_id === TZ.trader.id;

    // A spectator who opened this trade via a shared /trade/:id link is
    // not a party to it — RLS would reject any consent/generate RPC from
    // them anyway, so just show the finished image (if any), read-only.
    if (!isParty) {
      container.innerHTML = trade.share_image_url
        ? `<div class="tz-share-block"><img src="${trade.share_image_url}" class="tz-share-img" alt="Trade share graphic"></div>`
        : '';
      return;
    }

    const iAmA = trade.trader_a_id === TZ.trader.id;
    const myConsent = iAmA ? trade.share_consent_a : trade.share_consent_b;

    container.innerHTML = `
      <div class="tz-share-block">
        <label class="tz-consent-row">
          <input type="checkbox" ${myConsent ? 'checked' : ''}
                 onchange="TradeShare._toggleConsent('${trade.id}', this.checked)">
          Show my handle on the shared image
        </label>
        <div class="tz-share-actions" id="tzShareActions_${trade.id}">
          <button class="tz-share-generate-btn" onclick="TradeShare._generateAndOpen('${trade.id}')">
            🎨 Generate Share Image
          </button>
        </div>
        <div class="tz-share-preview" id="tzSharePreview_${trade.id}" style="display:none"></div>
      </div>
    `;

    // If a share image already exists (a prior visit/device generated
    // one), show it immediately instead of the generate button.
    if (trade.share_image_url) {
      _showGeneratedImage(trade.id, trade.share_image_url);
    }
  }

  async function _toggleConsent(tradeId, consent) {
    const { error } = await db.rpc('set_trade_share_consent', { p_trade_id: tradeId, p_consent: consent });
    if (error) { tzToast('Could not update consent: ' + error.message, 'var(--danger, #ef4444)'); return; }
    const t = TZ.myTrades.find(x => x.id === tradeId);
    if (t) {
      if (t.trader_a_id === TZ.trader.id) t.share_consent_a = consent;
      else t.share_consent_b = consent;
    }
  }

  async function _generateAndOpen(tradeId) {
    const trade = TZ.myTrades.find(t => t.id === tradeId);
    if (!trade) return;
    const actionsEl = document.getElementById(`tzShareActions_${tradeId}`);
    const btn = actionsEl.querySelector('.tz-share-generate-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

    try {
      const postA = TZ.postCache[trade.post_a_id];
      const postB = TZ.postCache[trade.post_b_id];
      if (!postA || !postB) throw new Error('Missing card data for this trade');

      const iAmA = trade.trader_a_id === TZ.trader.id;
      const myHandle = (iAmA ? trade.share_consent_a : trade.share_consent_b) ? (TZ.trader.handle || null) : null;

      let partnerHandle = null;
      const { data: partner } = await db.rpc('get_trade_partner_handle', { p_trade_id: tradeId });
      partnerHandle = partner || null;

      const handleA = iAmA ? myHandle : partnerHandle;
      const handleB = iAmA ? partnerHandle : myHandle;

      const blob = await _composite(postA, postB, handleA, handleB);
      const path = `trades/${tradeId}/card.png`;
      const { error: upErr } = await db.storage.from('trade-zone-shares').upload(path, blob, {
        contentType: 'image/png', upsert: true,
      });
      if (upErr) throw new Error('Upload failed: ' + upErr.message);

      const publicUrl = db.storage.from('trade-zone-shares').getPublicUrl(path).data.publicUrl;
      const { error: rpcErr } = await db.rpc('set_trade_share_image', { p_trade_id: tradeId, p_url: publicUrl });
      if (rpcErr) throw new Error(rpcErr.message);

      trade.share_image_url = publicUrl;
      _showGeneratedImage(tradeId, publicUrl, blob);
      tzToast('Share image ready!');
    } catch (err) {
      console.error('[trade-share] generate failed:', err);
      tzToast(err.message, 'var(--danger, #ef4444)');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🎨 Generate Share Image'; }
    }
  }

  function _composite(postA, postB, handleA, handleB) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      const ctx = canvas.getContext('2d');

      // Gradient background
      const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
      grad.addColorStop(0, '#07080c');
      grad.addColorStop(1, '#1a1200');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      Promise.all([_loadImage(postA.image_url), _loadImage(postB.image_url)])
        .then(([imgA, imgB]) => {
          const cardW = 760, cardH = 640;
          const cardX = (CANVAS_W - cardW) / 2;

          _drawCardImage(ctx, imgA, cardX, 220, cardW, cardH);
          _drawCardImage(ctx, imgB, cardX, 1000, cardW, cardH);

          // Swap icon between the two cards
          ctx.save();
          ctx.fillStyle = '#f5c842';
          ctx.beginPath();
          ctx.arc(CANVAS_W / 2, 920, 56, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#07080c';
          ctx.font = '700 56px "DM Sans", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('⇄', CANVAS_W / 2, 926);
          ctx.restore();

          // Card names
          ctx.fillStyle = '#e8eaf5';
          ctx.font = '500 34px "DM Sans", sans-serif';
          ctx.textAlign = 'center';
          _wrapText(ctx, postA.card_name, CANVAS_W / 2, 900, 900, 40);
          _wrapText(ctx, postB.card_name, CANVAS_W / 2, 1680, 900, 40);

          // Handles (only when consented — may be null)
          ctx.font = '400 28px "DM Mono", monospace';
          ctx.fillStyle = '#f5c842';
          if (handleA) ctx.fillText('@' + handleA, CANVAS_W / 2, 940);
          if (handleB) ctx.fillText('@' + handleB, CANVAS_W / 2, 1720);

          // Header
          ctx.textAlign = 'left';
          ctx.font = '700 44px "Bebas Neue", sans-serif';
          ctx.fillStyle = '#f5c842';
          ctx.fillText('TRADE ZONE', 60, 120);
          ctx.font = '400 26px "DM Sans", sans-serif';
          ctx.fillStyle = '#5a6585';
          ctx.fillText(TZ.show ? TZ.show.name : 'CardShow', 60, 160);

          // Footer watermark
          ctx.textAlign = 'center';
          ctx.font = '700 30px "Bebas Neue", sans-serif';
          ctx.fillStyle = '#f5c842';
          ctx.fillText('CARDSHOW', CANVAS_W / 2, CANVAS_H - 60);
          ctx.font = '400 20px "DM Sans", sans-serif';
          ctx.fillStyle = '#5a6585';
          ctx.fillText('getcardshow.com', CANVAS_W / 2, CANVAS_H - 30);

          canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('canvas export failed')), 'image/png');
        })
        .catch(reject);
    });
  }

  function _drawCardImage(ctx, img, x, y, w, h) {
    ctx.save();
    ctx.fillStyle = '#131828';
    ctx.strokeStyle = '#1e2640';
    ctx.lineWidth = 3;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    // Fit image (contain) inside the frame
    const scale = Math.min(w / img.width, h / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  }

  function _wrapText(ctx, text, cx, y, maxWidth, lineHeight) {
    const words = String(text || '').split(' ');
    let line = '';
    const lines = [];
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    const startY = y - ((lines.length - 1) * lineHeight) / 2;
    lines.slice(0, 2).forEach((l, i) => ctx.fillText(l, cx, startY + i * lineHeight));
  }

  function _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load card image for the share graphic'));
      img.src = src;
    });
  }

  function _showGeneratedImage(tradeId, url, blob) {
    const el = document.getElementById(`tzSharePreview_${tradeId}`);
    const actionsEl = document.getElementById(`tzShareActions_${tradeId}`);
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = `
      <img src="${url}" class="tz-share-img" alt="Trade share graphic">
      <div class="tz-share-btn-row">
        <button onclick="TradeShare._share('${tradeId}', 'instagram_story')">📸 Share to Story</button>
        <button onclick="TradeShare._share('${tradeId}', 'x')">🐦 Share to X</button>
        <button onclick="TradeShare._share('${tradeId}', 'download')">⬇ Save Image</button>
        <button onclick="TradeShare._share('${tradeId}', 'copy_link')">🔗 Copy Link</button>
      </div>
    `;
    if (actionsEl) actionsEl.innerHTML = '';
    if (blob) el._blob = blob;
  }

  async function _share(tradeId, platform) {
    const trade = TZ.myTrades.find(t => t.id === tradeId);
    if (!trade || !trade.share_image_url) return;
    const shareUrl = `${location.origin}/trade/${tradeId}`;

    try {
      if (platform === 'copy_link') {
        await navigator.clipboard.writeText(shareUrl);
        tzToast('Link copied!');
      } else if (platform === 'download') {
        const a = document.createElement('a');
        a.href = trade.share_image_url;
        a.download = `cardshow-trade-${tradeId}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else if (navigator.share && navigator.canShare) {
        const resp = await fetch(trade.share_image_url);
        const blob = await resp.blob();
        const file = new File([blob], 'cardshow-trade.png', { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'My CardShow Trade', text: shareUrl });
        } else {
          await navigator.share({ title: 'My CardShow Trade', url: shareUrl });
        }
      } else {
        window.open(trade.share_image_url, '_blank');
      }

      await db.from('share_events').insert({ trade_id: tradeId, platform });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[trade-share] share failed:', err);
        tzToast('Could not share — try Save Image instead', 'var(--danger, #ef4444)');
      }
    }
  }

  window.TradeShare = { renderShareSlot, _toggleConsent, _generateAndOpen, _share };
})();
