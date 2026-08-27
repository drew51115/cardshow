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

    // A guest's `handle` is null until they either claim a full account
    // (email+password, via tzSubmitClaim) or set one right here — the
    // consent checkbox alone has nothing to show without one. Without
    // this, checking "Show my handle" silently does nothing, which is
    // exactly the bug this block fixes: the compositor was always
    // passing null for a handle-less trader regardless of consent.
    const handleRowHTML = !TZ.trader.handle ? `
      <div class="tz-handle-row">
        <input type="text" id="tzHandleInput_${trade.id}" placeholder="@yourhandle" maxlength="32">
        <button onclick="TradeShare._setHandle('${trade.id}')">Set</button>
      </div>
      <div class="tz-handle-hint">Add a handle above to show it on the shared image</div>
    ` : '';

    container.innerHTML = `
      <div class="tz-share-block">
        <label class="tz-consent-row">
          <input type="checkbox" ${myConsent ? 'checked' : ''}
                 onchange="TradeShare._toggleConsent('${trade.id}', this.checked)">
          Show my handle on the shared image
        </label>
        ${handleRowHTML}
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

  async function _setHandle(tradeId) {
    const input = document.getElementById(`tzHandleInput_${tradeId}`);
    if (!input) return;
    const handle = input.value.trim().replace(/^@/, '');
    if (!handle) { tzToast('Enter a handle first', 'var(--danger, #ef4444)'); return; }

    const { error } = await db.from('traders').update({ handle }).eq('id', TZ.trader.id);
    if (error) { tzToast('Could not save handle: ' + error.message, 'var(--danger, #ef4444)'); return; }

    TZ.trader.handle = handle;
    tzToast('Handle saved!');

    // Re-render this trade's share slot — the handle-set row disappears
    // now that TZ.trader.handle is set, and if an image was already
    // generated without a handle (like this exact bug report), the
    // regenerate button in _showGeneratedImage lets them fix it.
    const trade = TZ.myTrades.find(t => t.id === tradeId);
    const slot = document.getElementById(`tzShareSlot_${tradeId}`);
    if (trade && slot) renderShareSlot(slot, trade, TZ.postCache);
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
    else tzToast('Regenerating…'); // called via the "Regenerate" link on an already-generated image, no button to relabel

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
          const cardW = 760, cardH = 540;
          const cardX = (CANVAS_W - cardW) / 2;
          const NAME_FONT = '600 36px "DM Sans", sans-serif';
          const NAME_SIZE = 36, NAME_LINE_H = 42;
          const HANDLE_FONT = '400 26px "DM Mono", monospace';
          const HANDLE_SIZE = 26;
          const CARD_TO_NAME_GAP = 32;   // clearance below each card image before its title
          const NAME_TO_HANDLE_GAP = 10;
          const PRE_ICON_GAP = 34;       // clearance below card A's text block before the swap icon
          const POST_ICON_GAP = 34;      // clearance below the swap icon before card B's image
          const ICON_R = 50;

          // Header
          ctx.textAlign = 'left';
          ctx.font = '700 44px "Bebas Neue", sans-serif';
          ctx.fillStyle = '#f5c842';
          ctx.fillText('TRADE ZONE', 60, 90);
          ctx.font = '400 26px "DM Sans", sans-serif';
          ctx.fillStyle = '#5a6585';
          ctx.fillText(TZ.show ? TZ.show.name : 'CardShow', 60, 130);

          // Card A image + title (+ optional handle)
          let y = 180;
          _drawCardImage(ctx, imgA, cardX, y, cardW, cardH);
          y += cardH + CARD_TO_NAME_GAP;

          ctx.textAlign = 'center';
          ctx.fillStyle = '#e8eaf5';
          ctx.font = NAME_FONT;
          y = _drawWrappedText(ctx, postA.card_name, CANVAS_W / 2, y, 900, NAME_SIZE, NAME_LINE_H, 2);

          if (handleA) {
            ctx.font = HANDLE_FONT;
            ctx.fillStyle = '#f5c842';
            y = _drawWrappedText(ctx, '@' + handleA, CANVAS_W / 2, y + NAME_TO_HANDLE_GAP, 900, HANDLE_SIZE, HANDLE_SIZE + 8, 1);
          }

          // Swap icon — positioned relative to wherever card A's title/handle
          // block actually ended, so it can never overlap a long (2-line) title
          y += PRE_ICON_GAP;
          const iconCenterY = y + ICON_R;
          ctx.save();
          ctx.fillStyle = '#f5c842';
          ctx.beginPath();
          ctx.arc(CANVAS_W / 2, iconCenterY, ICON_R, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#07080c';
          ctx.font = '700 50px "DM Sans", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('⇄', CANVAS_W / 2, iconCenterY + 4);
          ctx.restore();
          y = iconCenterY + ICON_R + POST_ICON_GAP;

          // Card B image + title (+ optional handle)
          _drawCardImage(ctx, imgB, cardX, y, cardW, cardH);
          y += cardH + CARD_TO_NAME_GAP;

          ctx.textAlign = 'center';
          ctx.fillStyle = '#e8eaf5';
          ctx.font = NAME_FONT;
          y = _drawWrappedText(ctx, postB.card_name, CANVAS_W / 2, y, 900, NAME_SIZE, NAME_LINE_H, 2);

          if (handleB) {
            ctx.font = HANDLE_FONT;
            ctx.fillStyle = '#f5c842';
            y = _drawWrappedText(ctx, '@' + handleB, CANVAS_W / 2, y + NAME_TO_HANDLE_GAP, 900, HANDLE_SIZE, HANDLE_SIZE + 8, 1);
          }

          // Footer watermark — enlarged for legibility at share-image size
          ctx.textAlign = 'center';
          ctx.font = '700 44px "Bebas Neue", sans-serif';
          ctx.fillStyle = '#f5c842';
          ctx.fillText('CARDSHOW', CANVAS_W / 2, CANVAS_H - 68);
          ctx.font = '400 26px "DM Sans", sans-serif';
          ctx.fillStyle = '#5a6585';
          ctx.fillText('getcardshow.com', CANVAS_W / 2, CANVAS_H - 34);

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

  // Wraps text to maxWidth (up to maxLines), drawing each line top-anchored
  // starting at topY, and returns the Y just below the last line drawn —
  // callers chain this into the next element's position so nothing is ever
  // placed at a fixed pixel that could collide with a longer-than-expected
  // block above it (the original bug: a 2-line title drawn at a fixed Y
  // that assumed a 1-line title, overlapping the swap icon below it).
  function _drawWrappedText(ctx, text, cx, topY, maxWidth, fontSize, lineHeight, maxLines) {
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
    const drawn = lines.slice(0, maxLines || lines.length);
    drawn.forEach((l, i) => ctx.fillText(l, cx, topY + fontSize * 0.8 + i * lineHeight));
    return topY + drawn.length * lineHeight;
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
      <button class="tz-share-regenerate-btn" onclick="TradeShare._generateAndOpen('${tradeId}')">🔄 Regenerate</button>
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

  window.TradeShare = { renderShareSlot, _toggleConsent, _setHandle, _generateAndOpen, _share };
})();
