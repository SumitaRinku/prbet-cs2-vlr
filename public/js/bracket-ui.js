// One delegated controller for both the home page and tournament archive.
(function () {
    const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function columnStarts(viewport) {
        // DOM offsets include a centered canvas and work for official, inferred and Swiss layouts.
        const frame = viewport.getBoundingClientRect();
        const headers = viewport.querySelectorAll('[data-bracket-column]');
        const nodes = headers.length ? headers : viewport.querySelectorAll('.sw2-column,.de-round,.pb2-title');
        return [...new Set([...nodes].map(node => Math.round(node.getBoundingClientRect().left - frame.left + viewport.scrollLeft)))].sort((a, b) => a - b);
    }
    function refresh(view) {
        const viewport = view.querySelector('.bracket-viewport');
        if (!viewport || !viewport.clientWidth) return;
        for (const canvas of viewport.querySelectorAll('.official-canvas,.pb2-layout')) {
            const folded = foldState(canvas);
            const next = BracketGraph.autoCollapsedColumns(folded.columns, folded.width, viewport.clientWidth - 16, folded.manual);
            if (next.size !== folded.collapsed.size || [...next].some(x => !folded.collapsed.has(x))) {
                folded.collapsed = next;
                applyColumns(canvas, folded);
                trace(view, '');
            }
        }
        const width = viewport.querySelector('.bracket-match,.sw2-column,.de-round,.pb2-slot')?.getBoundingClientRect().width || 180;
        const starts = columnStarts(viewport), frame = viewport.getBoundingClientRect();
        const widths = new Map([...viewport.querySelectorAll('.pb2-title')].map(node => {
            const rect = node.getBoundingClientRect();
            return [Math.round(rect.left - frame.left + viewport.scrollLeft), rect.width];
        }));
        const state = BracketGraph.scrollState(starts, viewport.scrollLeft, viewport.clientWidth, viewport.scrollWidth, starts.map(x => widths.get(x) || width));
        view.classList.toggle('is-overflowing', state.overflow);
        view.classList.toggle('has-previous', state.previous);
        view.classList.toggle('has-next', state.next);
        const previous = view.querySelector('[data-bracket-nav="-1"]'), next = view.querySelector('[data-bracket-nav="1"]');
        if (previous) previous.disabled = !state.previous;
        if (next) next.disabled = !state.next;
        const indicator = view.querySelector('.bracket-round-index');
        const text = state.total ? `${state.first + 1}${state.last > state.first ? `–${state.last + 1}` : ''} / ${state.total} 轮` : '';
        if (indicator && indicator.textContent !== text) indicator.textContent = text;
    }
    const pending = new Set(); let frame = 0;
    function schedule(view) {
        if (!view) return;
        pending.add(view);
        if (!frame) frame = requestAnimationFrame(() => {
            frame = 0;
            for (const item of pending) if (item.isConnected) refresh(item);
            pending.clear();
        });
    }
    const registered = new WeakSet();
    const folding = new WeakMap();
    function foldState(canvas) {
        let state = folding.get(canvas);
        if (!state) {
            const items = [...canvas.querySelectorAll('.pb2-title,.pb2-slot')].map(node => ({
                node, x: parseFloat(node.style.left), width: parseFloat(node.style.width)
            })).filter(item => Number.isFinite(item.x) && Number.isFinite(item.width));
            const columns = [...new Map(items.filter(item => item.node.matches('.pb2-title')).map(item => [item.x, { x: item.x, width: item.width }])).values()];
            for (const column of columns) {
                const cards = items.filter(item => item.x === column.x && item.node.matches('.pb2-slot')).map(item => item.node.querySelector('.pb2-card'));
                column.priority = cards.length && cards.every(card => card?.classList.contains('finished')) ? 0
                    : cards.length && cards.every(card => card?.classList.contains('finished') || card?.classList.contains('tbd')) ? 1
                    : cards.some(card => card?.classList.contains('live')) ? 3 : 2;
            }
            const svg = canvas.querySelector('.pb2-lines');
            state = { items, columns, svg, width: parseFloat(canvas.style.getPropertyValue('--pb2-w')) || parseFloat(canvas.style.width) || canvas.getBoundingClientRect().width,
                viewBox: svg?.getAttribute('viewBox')?.split(/\s+/).map(Number),
                paths: [...canvas.querySelectorAll('.pb2-lines path')].map(node => ({ node, d: node.getAttribute('d') })), collapsed: new Set(), manual: new Map() };
            folding.set(canvas, state);
        }
        return state;
    }
    function toggleColumn(header) {
        const canvas = header.closest('.official-canvas,.pb2-layout');
        if (!canvas) return;
        const state = foldState(canvas);
        const item = state.items.find(item => item.node === header);
        if (!item) return;
        if (state.collapsed.has(item.x)) state.collapsed.delete(item.x); else state.collapsed.add(item.x);
        state.manual.set(item.x, state.collapsed.has(item.x));
        applyColumns(canvas, state);
        const view = canvas.closest('[data-bracket-view]');
        trace(view, '');
        schedule(view);
    }
    function applyColumns(canvas, state) {
        const project = BracketGraph.columnProjection(state.columns, state.collapsed);
        for (const { node, x, width } of state.items) {
            const collapsed = state.collapsed.has(x);
            node.style.left = `${project(x)}px`;
            node.style.width = `${collapsed ? Math.min(72, width) : width}px`;
            node.classList.toggle('is-column-collapsed', collapsed);
            if (node.matches('.pb2-title')) {
                node.setAttribute('aria-expanded', String(!collapsed));
                node.title = `${collapsed ? '展开' : '折叠'}本列 · ${node.textContent}`;
            }
        }
        const width = project(state.width);
        canvas.style.width = `${width}px`;
        canvas.style.setProperty('--pb2-w', `${width}px`);
        if (state.svg && state.viewBox) state.svg.setAttribute('viewBox', `0 0 ${width} ${state.viewBox[3]}`);
        for (const { node, d } of state.paths) node.setAttribute('d', d.replace(/([MH])(-?[\d.]+)/g, (_, command, x) => command + project(Number(x))));
    }
    const scrollHandlers = new WeakMap();
    const resize = new ResizeObserver(entries => entries.forEach(entry => schedule(entry.target.closest('[data-bracket-view]'))));
    const viewsIn = root => root.matches?.('[data-bracket-view]') ? [root] : root.querySelectorAll?.('[data-bracket-view]') || [];
    function register(root) {
        for (const view of viewsIn(root)) {
            if (registered.has(view)) continue;
            registered.add(view);
            const viewport = view.querySelector('.bracket-viewport');
            if (!viewport) continue;
            for (const header of viewport.querySelectorAll('.pb2-title')) {
                header.setAttribute('role', 'button');
                header.tabIndex = 0;
                header.setAttribute('aria-expanded', 'true');
                header.title = `折叠本列 · ${header.textContent}`;
            }
            const onScroll = () => schedule(view);
            scrollHandlers.set(viewport, onScroll);
            viewport.addEventListener('scroll', onScroll, { passive: true });
            resize.observe(viewport);
            schedule(view);
        }
    }
    register(document);
    new MutationObserver(records => {
        // Archive navigation replaces whole graphs; release observations on removed views.
        for (const record of records) for (const node of record.removedNodes) if (node.nodeType === 1) {
            for (const view of viewsIn(node)) {
                const viewport = view.querySelector('.bracket-viewport');
                if (viewport) {
                    resize.unobserve(viewport);
                    viewport.removeEventListener('scroll', scrollHandlers.get(viewport));
                    scrollHandlers.delete(viewport);
                }
                registered.delete(view);
                pending.delete(view);
            }
        }
        for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) register(node);
    }).observe(document.body, { childList: true, subtree: true });
    function move(view, direction) {
        if (!view) return;
        const viewport = view.querySelector('.bracket-viewport');
        if (!viewport) return;
        let left, top = viewport.scrollTop;
        if (direction === 'current') {
            const current = viewport.querySelector('.live') || viewport.querySelector('.upcoming:not(.tbd)');
            if (!current) { left = 0; top = 0; }
            else {
                const bounds = current.getBoundingClientRect(), frame = viewport.getBoundingClientRect();
                left = bounds.left - frame.left + viewport.scrollLeft - 20;
                top = bounds.top - frame.top + viewport.scrollTop - viewport.clientHeight / 2 + bounds.height / 2;
            }
        } else {
            const columns = columnStarts(viewport);
            left = Number(direction) > 0 ? columns.find(x => x > viewport.scrollLeft + 24) : columns.reverse().find(x => x < viewport.scrollLeft - 24);
            left = left === undefined ? viewport.scrollLeft + Number(direction) * viewport.clientWidth * .8 : left - 16;
        }
        viewport.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: reducedMotion() ? 'instant' : 'smooth' });
    }
    document.addEventListener('click', event => {
        const header = event.target.closest('.pb2-title[role="button"]');
        if (header) { toggleColumn(header); return; }
        const button = event.target.closest('[data-bracket-nav]');
        if (button) {
            const view = button.closest('[data-bracket-view]');
            trace(view, '');
            move(view, button.dataset.bracketNav);
            return;
        }
        // A blank-area click restores the overview without intercepting cards or other controls.
        if (!event.target.closest('[data-bracket-match],button,a,input,select,textarea,[role="button"]')) {
            for (const view of document.querySelectorAll('[data-bracket-view].is-tracing')) trace(view, '');
        }
    });
    document.addEventListener('keydown', event => {
        const header = event.target.closest('.pb2-title[role="button"]');
        if (header && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            toggleColumn(header);
        }
    });
    function trace(view, id) {
        if (!view) return;
        if (view.dataset.trace === id) return;
        view.dataset.trace = id;
        const edges = [...view.querySelectorAll('.bracket-edge')];
        const related = new Set(id ? [id] : []);
        // Follow ancestors and descendants separately; don't expand into unrelated sibling branches.
        for (const direction of ['from', 'to']) {
            const visited = new Set(id ? [id] : []), queue = id ? [id] : [];
            for (const current of queue) for (const edge of edges) {
                const origin = direction === 'from' ? edge.dataset.to : edge.dataset.from;
                const target = edge.dataset[direction];
                if (origin === current && !visited.has(target)) { visited.add(target); related.add(target); queue.push(target); }
            }
        }
        view.classList.toggle('is-tracing', !!id);
        for (const card of view.querySelectorAll('[data-bracket-match]')) card.classList.toggle('is-related', related.has(card.dataset.bracketMatch));
        for (const edge of edges) edge.classList.toggle('is-related', related.has(edge.dataset.from) && related.has(edge.dataset.to));
    }
    for (const type of ['pointerover', 'focusin']) document.addEventListener(type, event => {
        const card = event.target.closest('[data-bracket-match]');
        if (card) trace(card.closest('[data-bracket-view]'), card.dataset.bracketMatch);
    });
    document.addEventListener('pointerout', event => {
        const view = event.target.closest('[data-bracket-view]');
        if (view && !view.contains(event.relatedTarget)) trace(view, '');
    });
    document.addEventListener('focusout', event => {
        const view = event.target.closest('[data-bracket-view]');
        if (view && !view.contains(event.relatedTarget)) trace(view, '');
    });
})();
