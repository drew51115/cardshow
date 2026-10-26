(function(){
  const today = new Date().toLocaleDateString('en-CA');
  const UID = 'u1';
  const S = window.__srv = JSON.parse(localStorage.getItem('__srv') || 'null') || {
    sellers: [{ id: UID, handle: 'tester', display_name: 'Tester', onboarding_complete: true, onboarding_state: null }],
    admins: [],
    shows: [{ id:'show_a', name:'Monster Show', date:'Today', location:'Cal Expo, Sacramento, CA', status:'active', access_code:'MON', start_date: today, end_date: today }],
    show_sellers: [{ show_id:'show_a', seller_id: UID, table_number:'12' }],
    inventory: [
      { id:'c1', seller_id:UID, card_title:'2024 Bowman Chrome Dylan Crews', player:'Dylan Crews', year:2024, card_set:'Bowman Chrome', card_number:'BCP-1', grader:'PSA', grade:10, cert_number:'12345678', price:120, status:'Available' },
      { id:'c2', seller_id:UID, card_title:'2023 Topps Chrome Elly De La Cruz', player:'Elly De La Cruz', year:2023, card_set:'Topps Chrome', grader:null, grade:null, price:40, status:'Available' },
      { id:'c3', seller_id:UID, card_title:'2018 Prizm Luka Doncic', player:'Luka Doncic', year:2018, card_set:'Prizm', grader:'PSA', grade:9, price:300, status:'Sold', sold_price:280, payment_method:'Venmo', sold_time:'1:05 PM', sold_date: today },
    ],
    show_inventory: [{ show_id:'show_a', card_id:'c1' }, { show_id:'show_a', card_id:'c2' }],
    sales: [], card_captures: [], show_floor_transactions: [], storage: [], show_events: [],
    cert_trust_checks: [], gtcr_consent_events: [],
  };
  const save = () => localStorage.setItem('__srv', JSON.stringify(S));
  const offline = () => !navigator.onLine;
  const netErr = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 };
  window.__mockLog = [];
  function q(table){
    let rows = null, single=false, op='select', payload=null, filters=[], opts={};
    const b = {
      select(){ return b; }, order(){ return b; }, range(){ return b; }, limit(){ return b; },
      eq(c,v){ filters.push(r=>String(r[c])===String(v)); return b; },
      neq(c,v){ filters.push(r=>String(r[c])!==String(v)); return b; },
      in(c,vs){ filters.push(r=>vs.map(String).includes(String(r[c]))); return b; },
      is(c,v){ filters.push(r=> v===null ? (r[c]==null) : r[c]===v); return b; },
      gte(c,v){ filters.push(r=> String(r[c]) >= String(v)); return b; },
      not(c,o,v){ if (o==='is' && v===null) filters.push(r=>r[c]!=null); return b; }, lte(){ return b; }, ilike(){ return b; }, or(){ return b; }, filter(){ return b; },
      maybeSingle(){ single=true; return b; }, single(){ single=true; return b; },
      insert(p){ op='insert'; payload=p; return b; },
      upsert(p,o){ op='upsert'; payload=p; opts=o||{}; return b; },
      update(p){ op='update'; payload=p; return b; },
      delete(){ op='delete'; return b; },
      then(res, rej){
        if (offline()) return Promise.resolve(netErr).then(res, rej);
        window.__mockLog.push({table, op, payload});
        const T = (S[table] = S[table] || []);
        let out = { data: null, error: null, status: 200 };
        const match = r => filters.every(f => f(r));
        if (op === 'select') { const d = T.filter(match); out.data = single ? (d[0]||null) : d; }
        else if (op === 'insert' || op === 'upsert') {
          const list = Array.isArray(payload) ? payload : [payload];
          for (const p of list) {
            const row = Object.assign({ id: p.id || ('gen_' + Math.random().toString(36).slice(2)) }, p);
            if (table === 'card_captures') row.status = row.status || 'unattached';
            if (table === 'show_floor_transactions' && row.client_sale_id && T.some(r => r.client_sale_id === row.client_sale_id)) {
              out = { data:null, error:{ message:'duplicate key value violates unique constraint', code:'23505' }, status:409 }; continue;
            }
            const existing = T.find(r => r.id === row.id);
            if (existing) { if (op === 'upsert' && !opts.ignoreDuplicates) Object.assign(existing, row); }
            else T.push(row);
          }
          out.data = single ? { id: list[0].id || T[T.length-1].id } : list.map(p => ({ id: p.id }));
        }
        else if (op === 'update') { T.filter(match).forEach(r => Object.assign(r, payload)); }
        else if (op === 'delete') { S[table] = T.filter(r => !match(r)); }
        save();
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  }
  function rpc(name, a){
    if (offline()) return Promise.resolve(netErr);
    window.__mockLog.push({ table: 'rpc', op: name, payload: a });
    let data = null;
    if (name === 'record_sale') {
      const ex = S.sales.find(s => s.client_sale_id === a.p_client_sale_id);
      if (ex) data = { created:false, sale_id: ex.id, inventory_id: ex.inventory_id, status: ex.status, sold_at: ex.sold_at };
      else {
        let invId = a.p_inventory_id;
        if (invId) {
          const inv = S.inventory.find(r => r.id === invId);
          if (!inv) return Promise.resolve({ data:null, error:{ message:'item_not_found', code:'P0002' }, status:400 });
          if ((inv.status||'').toLowerCase() === 'sold') { data = { error:'already_sold', inventory_id: invId }; save(); return Promise.resolve({ data, error:null, status:200 }); }
          Object.assign(inv, { status:'Sold', sold_price:a.p_price, payment_method:a.p_payment_method, sold_date:a.p_sold_date, sold_time:a.p_sold_time });
        } else {
          invId = a.p_new_item.id;
          S.inventory.push(Object.assign({}, a.p_new_item, { seller_id: UID, status:'Sold', sold_price:a.p_price, payment_method:a.p_payment_method, sold_date:a.p_sold_date, sold_time:a.p_sold_time, source:a.p_source }));
        }
        if (a.p_show_id && !S.show_inventory.some(r => r.show_id===a.p_show_id && r.card_id===invId)) S.show_inventory.push({ show_id:a.p_show_id, card_id:invId });
        const sale = { id:'sale_'+S.sales.length, client_sale_id:a.p_client_sale_id, seller_id:UID, show_id:a.p_show_id, inventory_id:invId, capture_id:a.p_capture_id, price:a.p_price, payment_method:a.p_payment_method, buyer_handle:a.p_buyer_handle, source:a.p_source, status:'completed', sold_at:new Date().toISOString() };
        S.sales.push(sale);
        if (a.p_capture_id) { const c = S.card_captures.find(x => x.id === a.p_capture_id); if (c) { Object.assign(c, { inventory_id:invId, sale_id:sale.id, status:'attached' }); const inv = S.inventory.find(r=>r.id===invId); if (inv && !inv.primary_capture_id) inv.primary_capture_id = a.p_capture_id; } }
        data = { created:true, sale_id:sale.id, inventory_id:invId, status:'completed', sold_at:sale.sold_at };
      }
    } else if (name === 'join_show_as_seller') {
      const show = S.shows.find(x => x.id === a.p_show_id);
      if (!show) data = { error:'not_found' };
      else if (S.show_sellers.some(r => r.show_id === show.id && r.seller_id === UID)) data = { ok:true, already:true };
      else if (show.listed === false) data = { error:'not_listed' };
      else if (show.seller_self_join === false) data = { error:'closed' };
      else if ((show.end_date || show.start_date) && (show.end_date || show.start_date) < today) data = { error:'ended' };
      else { S.show_sellers.push({ show_id:show.id, seller_id:UID, table_number:null, self_joined:true }); data = { ok:true, already:false }; }
    } else if (name === 'leave_show_as_seller') {
      const row = S.show_sellers.find(r => r.show_id === a.p_show_id && r.seller_id === UID);
      if (!row) data = { error:'not_joined' };
      else if (!row.self_joined) data = { error:'organizer_added' };
      else {
        const mine = new Set(S.inventory.filter(r => r.seller_id === UID).map(r => r.id));
        const before = S.show_inventory.length;
        S.show_inventory = S.show_inventory.filter(r => !(r.show_id === a.p_show_id && mine.has(r.card_id)));
        S.show_sellers = S.show_sellers.filter(r => r !== row);
        data = { ok:true, cards_removed: before - S.show_inventory.length };
      }
    } else if (name === 'is_platform_admin') {
      data = (S.platform_admins || []).some(r => r.id === UID);
    } else if (name === 'set_show_listed') {
      const show = S.shows.find(x => x.id === a.p_show_id);
      if (!(S.platform_admins || []).some(r => r.id === UID)) data = { error:'forbidden' };
      else if (!show) data = { error:'not_found' };
      else if (!a.p_listed) { show.listed = false; data = { ok:true, listed:false }; }
      else {
        const miss = [];
        if (!show.name) miss.push('name'); if (!show.start_date) miss.push('start_date');
        if (!show.venue) miss.push('venue'); if (!show.city) miss.push('city');
        if (!/^[A-Z]{2}$/.test(show.state || '')) miss.push('state'); if (show.merged_into) miss.push('merged');
        if (miss.length) data = { error:'missing_fields', fields: miss };
        else {
          show.slug = show.slug || (show.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + show.start_date.slice(0, 7));
          Object.assign(show, { listed:true, listed_at:new Date().toISOString() });
          data = { ok:true, listed:true, slug:show.slug };
        }
      }
    } else if (name === 'submit_show_request') {
      S.show_requests = S.show_requests || [];
      const p = a.p;
      if (!p.name || !p.start_date) data = { error:'missing_fields' };
      else {
        const ex = S.show_requests.find(r => r.seller_id === UID && r.status === 'pending' && r.name.toLowerCase() === p.name.toLowerCase() && r.start_date === p.start_date);
        if (ex) data = { ok:true, id:ex.id, already:true };
        else {
          const row = { id:'req_' + S.show_requests.length, seller_id:UID, status:'pending', created_at:new Date().toISOString(),
            name:p.name, start_date:p.start_date, end_date:p.end_date || null, venue:p.venue || null, city:p.city || null,
            state:p.state || null, website:p.website || null, notes:p.notes || null };
          S.show_requests.push(row); data = { ok:true, id:row.id, already:false };
        }
      }
    } else if (name === 'resolve_show_request') {
      const req = (S.show_requests || []).find(r => r.id === a.p_request_id);
      if (!(S.platform_admins || []).some(r => r.id === UID)) data = { error:'forbidden' };
      else if (!req) data = { error:'not_found' };
      else if (a.p_action === 'listed' && !S.shows.some(x => x.id === a.p_show_id && x.listed)) data = { error:'show_not_listed' };
      else {
        if (a.p_action === 'listed' && !S.show_sellers.some(r => r.show_id === a.p_show_id && r.seller_id === req.seller_id))
          S.show_sellers.push({ show_id:a.p_show_id, seller_id:req.seller_id, table_number:null, self_joined:true });
        Object.assign(req, { status:a.p_action, show_id:a.p_action === 'listed' ? a.p_show_id : null, review_note:a.p_note });
        data = { ok:true };
      }
    } else if (name === 'merge_shows') {
      let moved = 0, cards = 0;
      S.show_sellers.filter(r => r.show_id === a.p_from).forEach(r => {
        if (!S.show_sellers.some(t => t.show_id === a.p_into && t.seller_id === r.seller_id)) { S.show_sellers.push(Object.assign({}, r, { show_id:a.p_into })); moved++; }
      });
      S.show_inventory.filter(r => r.show_id === a.p_from).forEach(r => {
        if (!S.show_inventory.some(t => t.show_id === a.p_into && t.card_id === r.card_id)) { S.show_inventory.push({ show_id:a.p_into, card_id:r.card_id }); cards++; }
      });
      S.show_sellers = S.show_sellers.filter(r => r.show_id !== a.p_from);
      S.show_inventory = S.show_inventory.filter(r => r.show_id !== a.p_from);
      Object.assign(S.shows.find(x => x.id === a.p_from), { listed:false, seller_self_join:false, merged_into:a.p_into });
      data = { ok:true, sellers_moved:moved, cards_moved:cards };
    } else if (name === 'void_sale') {
      const s = S.sales.find(x => x.client_sale_id === a.p_client_sale_id);
      if (s.status === 'voided') data = { voided:false, status:'voided' };
      else {
        s.status = 'voided';
        const inv = S.inventory.find(r => r.id === s.inventory_id);
        Object.assign(inv, { status:'Available', sold_price:null, payment_method:null, sold_date:null, sold_time:null });
        const tx = S.show_floor_transactions.find(t => t.client_sale_id === s.client_sale_id);
        if (tx) S.show_floor_transactions.push(Object.assign({}, tx, { id:'rev_'+tx.id, client_sale_id:null, sold_price:-tx.sold_price, voids_transaction_id:tx.id }));
        data = { voided:true, status:'voided', inventory_id:s.inventory_id };
      }
    }
    save();
    return Promise.resolve({ data, error:null, status:200 });
  }
  window.supabase = { createClient(){ return {
    from: q, rpc,
    channel(){ const c={ on(){return c;}, subscribe(){return c;} }; return c; },
    removeChannel(){},
    storage: { from(){ return {
      upload: async (key)=>{ if (offline()) return { error:{ message:'Failed to fetch' } }; S.storage.push(key); save(); return { error:null }; },
      createSignedUrl: async ()=>({ data:{ signedUrl:'' } }),
      createSignedUrls: async (keys)=>({ data: keys.map(k=>({ path:k, signedUrl: location.origin + '/__signed/' + k, error:null })), error:null }),
      getPublicUrl: ()=>({ data:{ publicUrl:'' } }),
    }; } },
    auth: {
      async getSession(){ const s=localStorage.getItem('mock_session'); return { data:{ session: s? JSON.parse(s):null } }; },
      async signOut(){ localStorage.removeItem('mock_session'); return {error:null}; },
      async signInWithPassword(){ const s={user:{id:UID,email:'t@x.com'},access_token:'t'}; localStorage.setItem('mock_session',JSON.stringify(s)); return {data:{session:s,user:s.user},error:null}; },
      async getUser(){ const s=localStorage.getItem('mock_session'); return {data:{user:s?JSON.parse(s).user:null}}; },
      onAuthStateChange(){ return {data:{subscription:{unsubscribe(){}}}}; },
    },
  }; } };
})();
