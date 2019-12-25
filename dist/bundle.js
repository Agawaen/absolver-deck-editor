
(function(l, r) { if (l.getElementById('livereloadscript')) return; r = l.createElement('script'); r.async = 1; r.src = '//' + (window.location.host || 'localhost').split(':')[0] + ':35729/livereload.js?snipver=1'; r.id = 'livereloadscript'; l.head.appendChild(r) })(document);
(function () {
    'use strict';

    function noop() { }
    const identity = x => x;
    function assign(tar, src) {
        // @ts-ignore
        for (const k in src)
            tar[k] = src[k];
        return tar;
    }
    function run(fn) {
        return fn();
    }
    function blank_object() {
        return Object.create(null);
    }
    function run_all(fns) {
        fns.forEach(run);
    }
    function is_function(thing) {
        return typeof thing === 'function';
    }
    function safe_not_equal(a, b) {
        return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
    }
    function subscribe(store, callback) {
        const unsub = store.subscribe(callback);
        return unsub.unsubscribe ? () => unsub.unsubscribe() : unsub;
    }
    function get_store_value(store) {
        let value;
        subscribe(store, _ => value = _)();
        return value;
    }
    function component_subscribe(component, store, callback) {
        component.$$.on_destroy.push(subscribe(store, callback));
    }

    const is_client = typeof window !== 'undefined';
    let now = is_client
        ? () => window.performance.now()
        : () => Date.now();
    let raf = is_client ? cb => requestAnimationFrame(cb) : noop;

    const tasks = new Set();
    let running = false;
    function run_tasks() {
        tasks.forEach(task => {
            if (!task[0](now())) {
                tasks.delete(task);
                task[1]();
            }
        });
        running = tasks.size > 0;
        if (running)
            raf(run_tasks);
    }
    function loop(fn) {
        let task;
        if (!running) {
            running = true;
            raf(run_tasks);
        }
        return {
            promise: new Promise(fulfil => {
                tasks.add(task = [fn, fulfil]);
            }),
            abort() {
                tasks.delete(task);
            }
        };
    }

    function append(target, node) {
        target.appendChild(node);
    }
    function insert(target, node, anchor) {
        target.insertBefore(node, anchor || null);
    }
    function detach(node) {
        node.parentNode.removeChild(node);
    }
    function destroy_each(iterations, detaching) {
        for (let i = 0; i < iterations.length; i += 1) {
            if (iterations[i])
                iterations[i].d(detaching);
        }
    }
    function element(name) {
        return document.createElement(name);
    }
    function svg_element(name) {
        return document.createElementNS('http://www.w3.org/2000/svg', name);
    }
    function text(data) {
        return document.createTextNode(data);
    }
    function space() {
        return text(' ');
    }
    function empty() {
        return text('');
    }
    function listen(node, event, handler, options) {
        node.addEventListener(event, handler, options);
        return () => node.removeEventListener(event, handler, options);
    }
    function attr(node, attribute, value) {
        if (value == null)
            node.removeAttribute(attribute);
        else
            node.setAttribute(attribute, value);
    }
    function children(element) {
        return Array.from(element.childNodes);
    }
    function set_data(text, data) {
        data = '' + data;
        if (text.data !== data)
            text.data = data;
    }
    function custom_event(type, detail) {
        const e = document.createEvent('CustomEvent');
        e.initCustomEvent(type, false, false, detail);
        return e;
    }

    let stylesheet;
    let active = 0;
    let current_rules = {};
    // https://github.com/darkskyapp/string-hash/blob/master/index.js
    function hash(str) {
        let hash = 5381;
        let i = str.length;
        while (i--)
            hash = ((hash << 5) - hash) ^ str.charCodeAt(i);
        return hash >>> 0;
    }
    function create_rule(node, a, b, duration, delay, ease, fn, uid = 0) {
        const step = 16.666 / duration;
        let keyframes = '{\n';
        for (let p = 0; p <= 1; p += step) {
            const t = a + (b - a) * ease(p);
            keyframes += p * 100 + `%{${fn(t, 1 - t)}}\n`;
        }
        const rule = keyframes + `100% {${fn(b, 1 - b)}}\n}`;
        const name = `__svelte_${hash(rule)}_${uid}`;
        if (!current_rules[name]) {
            if (!stylesheet) {
                const style = element('style');
                document.head.appendChild(style);
                stylesheet = style.sheet;
            }
            current_rules[name] = true;
            stylesheet.insertRule(`@keyframes ${name} ${rule}`, stylesheet.cssRules.length);
        }
        const animation = node.style.animation || '';
        node.style.animation = `${animation ? `${animation}, ` : ``}${name} ${duration}ms linear ${delay}ms 1 both`;
        active += 1;
        return name;
    }
    function delete_rule(node, name) {
        node.style.animation = (node.style.animation || '')
            .split(', ')
            .filter(name
            ? anim => anim.indexOf(name) < 0 // remove specific animation
            : anim => anim.indexOf('__svelte') === -1 // remove all Svelte animations
        )
            .join(', ');
        if (name && !--active)
            clear_rules();
    }
    function clear_rules() {
        raf(() => {
            if (active)
                return;
            let i = stylesheet.cssRules.length;
            while (i--)
                stylesheet.deleteRule(i);
            current_rules = {};
        });
    }

    let current_component;
    function set_current_component(component) {
        current_component = component;
    }
    function createEventDispatcher() {
        const component = current_component;
        return (type, detail) => {
            const callbacks = component.$$.callbacks[type];
            if (callbacks) {
                // TODO are there situations where events could be dispatched
                // in a server (non-DOM) environment?
                const event = custom_event(type, detail);
                callbacks.slice().forEach(fn => {
                    fn.call(component, event);
                });
            }
        };
    }

    const dirty_components = [];
    const binding_callbacks = [];
    const render_callbacks = [];
    const flush_callbacks = [];
    const resolved_promise = Promise.resolve();
    let update_scheduled = false;
    function schedule_update() {
        if (!update_scheduled) {
            update_scheduled = true;
            resolved_promise.then(flush);
        }
    }
    function add_render_callback(fn) {
        render_callbacks.push(fn);
    }
    function flush() {
        const seen_callbacks = new Set();
        do {
            // first, call beforeUpdate functions
            // and update components
            while (dirty_components.length) {
                const component = dirty_components.shift();
                set_current_component(component);
                update(component.$$);
            }
            while (binding_callbacks.length)
                binding_callbacks.pop()();
            // then, once components are updated, call
            // afterUpdate functions. This may cause
            // subsequent updates...
            for (let i = 0; i < render_callbacks.length; i += 1) {
                const callback = render_callbacks[i];
                if (!seen_callbacks.has(callback)) {
                    callback();
                    // ...so guard against infinite loops
                    seen_callbacks.add(callback);
                }
            }
            render_callbacks.length = 0;
        } while (dirty_components.length);
        while (flush_callbacks.length) {
            flush_callbacks.pop()();
        }
        update_scheduled = false;
    }
    function update($$) {
        if ($$.fragment) {
            $$.update($$.dirty);
            run_all($$.before_update);
            $$.fragment.p($$.dirty, $$.ctx);
            $$.dirty = null;
            $$.after_update.forEach(add_render_callback);
        }
    }

    let promise;
    function wait() {
        if (!promise) {
            promise = Promise.resolve();
            promise.then(() => {
                promise = null;
            });
        }
        return promise;
    }
    function dispatch(node, direction, kind) {
        node.dispatchEvent(custom_event(`${direction ? 'intro' : 'outro'}${kind}`));
    }
    const outroing = new Set();
    let outros;
    function group_outros() {
        outros = {
            r: 0,
            c: [],
            p: outros // parent group
        };
    }
    function check_outros() {
        if (!outros.r) {
            run_all(outros.c);
        }
        outros = outros.p;
    }
    function transition_in(block, local) {
        if (block && block.i) {
            outroing.delete(block);
            block.i(local);
        }
    }
    function transition_out(block, local, detach, callback) {
        if (block && block.o) {
            if (outroing.has(block))
                return;
            outroing.add(block);
            outros.c.push(() => {
                outroing.delete(block);
                if (callback) {
                    if (detach)
                        block.d(1);
                    callback();
                }
            });
            block.o(local);
        }
    }
    const null_transition = { duration: 0 };
    function create_bidirectional_transition(node, fn, params, intro) {
        let config = fn(node, params);
        let t = intro ? 0 : 1;
        let running_program = null;
        let pending_program = null;
        let animation_name = null;
        function clear_animation() {
            if (animation_name)
                delete_rule(node, animation_name);
        }
        function init(program, duration) {
            const d = program.b - t;
            duration *= Math.abs(d);
            return {
                a: t,
                b: program.b,
                d,
                duration,
                start: program.start,
                end: program.start + duration,
                group: program.group
            };
        }
        function go(b) {
            const { delay = 0, duration = 300, easing = identity, tick = noop, css } = config || null_transition;
            const program = {
                start: now() + delay,
                b
            };
            if (!b) {
                // @ts-ignore todo: improve typings
                program.group = outros;
                outros.r += 1;
            }
            if (running_program) {
                pending_program = program;
            }
            else {
                // if this is an intro, and there's a delay, we need to do
                // an initial tick and/or apply CSS animation immediately
                if (css) {
                    clear_animation();
                    animation_name = create_rule(node, t, b, duration, delay, easing, css);
                }
                if (b)
                    tick(0, 1);
                running_program = init(program, duration);
                add_render_callback(() => dispatch(node, b, 'start'));
                loop(now => {
                    if (pending_program && now > pending_program.start) {
                        running_program = init(pending_program, duration);
                        pending_program = null;
                        dispatch(node, running_program.b, 'start');
                        if (css) {
                            clear_animation();
                            animation_name = create_rule(node, t, running_program.b, running_program.duration, 0, easing, config.css);
                        }
                    }
                    if (running_program) {
                        if (now >= running_program.end) {
                            tick(t = running_program.b, 1 - t);
                            dispatch(node, running_program.b, 'end');
                            if (!pending_program) {
                                // we're done
                                if (running_program.b) {
                                    // intro — we can tidy up immediately
                                    clear_animation();
                                }
                                else {
                                    // outro — needs to be coordinated
                                    if (!--running_program.group.r)
                                        run_all(running_program.group.c);
                                }
                            }
                            running_program = null;
                        }
                        else if (now >= running_program.start) {
                            const p = now - running_program.start;
                            t = running_program.a + running_program.d * easing(p / running_program.duration);
                            tick(t, 1 - t);
                        }
                    }
                    return !!(running_program || pending_program);
                });
            }
        }
        return {
            run(b) {
                if (is_function(config)) {
                    wait().then(() => {
                        // @ts-ignore
                        config = config();
                        go(b);
                    });
                }
                else {
                    go(b);
                }
            },
            end() {
                clear_animation();
                running_program = pending_program = null;
            }
        };
    }
    function outro_and_destroy_block(block, lookup) {
        transition_out(block, 1, 1, () => {
            lookup.delete(block.key);
        });
    }
    function update_keyed_each(old_blocks, changed, get_key, dynamic, ctx, list, lookup, node, destroy, create_each_block, next, get_context) {
        let o = old_blocks.length;
        let n = list.length;
        let i = o;
        const old_indexes = {};
        while (i--)
            old_indexes[old_blocks[i].key] = i;
        const new_blocks = [];
        const new_lookup = new Map();
        const deltas = new Map();
        i = n;
        while (i--) {
            const child_ctx = get_context(ctx, list, i);
            const key = get_key(child_ctx);
            let block = lookup.get(key);
            if (!block) {
                block = create_each_block(key, child_ctx);
                block.c();
            }
            else if (dynamic) {
                block.p(changed, child_ctx);
            }
            new_lookup.set(key, new_blocks[i] = block);
            if (key in old_indexes)
                deltas.set(key, Math.abs(i - old_indexes[key]));
        }
        const will_move = new Set();
        const did_move = new Set();
        function insert(block) {
            transition_in(block, 1);
            block.m(node, next);
            lookup.set(block.key, block);
            next = block.first;
            n--;
        }
        while (o && n) {
            const new_block = new_blocks[n - 1];
            const old_block = old_blocks[o - 1];
            const new_key = new_block.key;
            const old_key = old_block.key;
            if (new_block === old_block) {
                // do nothing
                next = new_block.first;
                o--;
                n--;
            }
            else if (!new_lookup.has(old_key)) {
                // remove old block
                destroy(old_block, lookup);
                o--;
            }
            else if (!lookup.has(new_key) || will_move.has(new_key)) {
                insert(new_block);
            }
            else if (did_move.has(old_key)) {
                o--;
            }
            else if (deltas.get(new_key) > deltas.get(old_key)) {
                did_move.add(new_key);
                insert(new_block);
            }
            else {
                will_move.add(old_key);
                o--;
            }
        }
        while (o--) {
            const old_block = old_blocks[o];
            if (!new_lookup.has(old_block.key))
                destroy(old_block, lookup);
        }
        while (n)
            insert(new_blocks[n - 1]);
        return new_blocks;
    }

    function get_spread_update(levels, updates) {
        const update = {};
        const to_null_out = {};
        const accounted_for = { $$scope: 1 };
        let i = levels.length;
        while (i--) {
            const o = levels[i];
            const n = updates[i];
            if (n) {
                for (const key in o) {
                    if (!(key in n))
                        to_null_out[key] = 1;
                }
                for (const key in n) {
                    if (!accounted_for[key]) {
                        update[key] = n[key];
                        accounted_for[key] = 1;
                    }
                }
                levels[i] = n;
            }
            else {
                for (const key in o) {
                    accounted_for[key] = 1;
                }
            }
        }
        for (const key in to_null_out) {
            if (!(key in update))
                update[key] = undefined;
        }
        return update;
    }
    function get_spread_object(spread_props) {
        return typeof spread_props === 'object' && spread_props !== null ? spread_props : {};
    }
    function mount_component(component, target, anchor) {
        const { fragment, on_mount, on_destroy, after_update } = component.$$;
        fragment.m(target, anchor);
        // onMount happens before the initial afterUpdate
        add_render_callback(() => {
            const new_on_destroy = on_mount.map(run).filter(is_function);
            if (on_destroy) {
                on_destroy.push(...new_on_destroy);
            }
            else {
                // Edge case - component was destroyed immediately,
                // most likely as a result of a binding initialising
                run_all(new_on_destroy);
            }
            component.$$.on_mount = [];
        });
        after_update.forEach(add_render_callback);
    }
    function destroy_component(component, detaching) {
        if (component.$$.fragment) {
            run_all(component.$$.on_destroy);
            component.$$.fragment.d(detaching);
            // TODO null out other refs, including component.$$ (but need to
            // preserve final state?)
            component.$$.on_destroy = component.$$.fragment = null;
            component.$$.ctx = {};
        }
    }
    function make_dirty(component, key) {
        if (!component.$$.dirty) {
            dirty_components.push(component);
            schedule_update();
            component.$$.dirty = blank_object();
        }
        component.$$.dirty[key] = true;
    }
    function init(component, options, instance, create_fragment, not_equal, prop_names) {
        const parent_component = current_component;
        set_current_component(component);
        const props = options.props || {};
        const $$ = component.$$ = {
            fragment: null,
            ctx: null,
            // state
            props: prop_names,
            update: noop,
            not_equal,
            bound: blank_object(),
            // lifecycle
            on_mount: [],
            on_destroy: [],
            before_update: [],
            after_update: [],
            context: new Map(parent_component ? parent_component.$$.context : []),
            // everything else
            callbacks: blank_object(),
            dirty: null
        };
        let ready = false;
        $$.ctx = instance
            ? instance(component, props, (key, ret, value = ret) => {
                if ($$.ctx && not_equal($$.ctx[key], $$.ctx[key] = value)) {
                    if ($$.bound[key])
                        $$.bound[key](value);
                    if (ready)
                        make_dirty(component, key);
                }
                return ret;
            })
            : props;
        $$.update();
        ready = true;
        run_all($$.before_update);
        $$.fragment = create_fragment($$.ctx);
        if (options.target) {
            if (options.hydrate) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment.l(children(options.target));
            }
            else {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment.c();
            }
            if (options.intro)
                transition_in(component.$$.fragment);
            mount_component(component, options.target, options.anchor);
            flush();
        }
        set_current_component(parent_component);
    }
    class SvelteComponent {
        $destroy() {
            destroy_component(this, 1);
            this.$destroy = noop;
        }
        $on(type, callback) {
            const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
            callbacks.push(callback);
            return () => {
                const index = callbacks.indexOf(callback);
                if (index !== -1)
                    callbacks.splice(index, 1);
            };
        }
        $set() {
            // overridden by instance, if it has props
        }
    }

    /*! *****************************************************************************
    Copyright (c) Microsoft Corporation. All rights reserved.
    Licensed under the Apache License, Version 2.0 (the "License"); you may not use
    this file except in compliance with the License. You may obtain a copy of the
    License at http://www.apache.org/licenses/LICENSE-2.0

    THIS CODE IS PROVIDED ON AN *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED
    WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A PARTICULAR PURPOSE,
    MERCHANTABLITY OR NON-INFRINGEMENT.

    See the Apache Version 2.0 License for specific language governing permissions
    and limitations under the License.
    ***************************************************************************** */
    var __assign = function () {
      __assign = Object.assign || function __assign(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
          s = arguments[i];

          for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
        }

        return t;
      };

      return __assign.apply(this, arguments);
    };

    function __rest(s, e) {
      var t = {};

      for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0) t[p] = s[p];

      if (s != null && typeof Object.getOwnPropertySymbols === "function") for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
        if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i])) t[p[i]] = s[p[i]];
      }
      return t;
    }

    function __values(o) {
      var m = typeof Symbol === "function" && o[Symbol.iterator],
          i = 0;
      if (m) return m.call(o);
      return {
        next: function () {
          if (o && i >= o.length) o = void 0;
          return {
            value: o && o[i++],
            done: !o
          };
        }
      };
    }

    function __read(o, n) {
      var m = typeof Symbol === "function" && o[Symbol.iterator];
      if (!m) return o;
      var i = m.call(o),
          r,
          ar = [],
          e;

      try {
        while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
      } catch (error) {
        e = {
          error: error
        };
      } finally {
        try {
          if (r && !r.done && (m = i["return"])) m.call(i);
        } finally {
          if (e) throw e.error;
        }
      }

      return ar;
    }

    function __spread() {
      for (var ar = [], i = 0; i < arguments.length; i++) ar = ar.concat(__read(arguments[i]));

      return ar;
    }

    var STATE_DELIMITER = '.';
    var EMPTY_ACTIVITY_MAP = {};
    var DEFAULT_GUARD_TYPE = 'xstate.guard';
    var TARGETLESS_KEY = '';

    function keys(value) {
      return Object.keys(value);
    }

    function matchesState(parentStateId, childStateId, delimiter) {
      if (delimiter === void 0) {
        delimiter = STATE_DELIMITER;
      }

      var parentStateValue = toStateValue(parentStateId, delimiter);
      var childStateValue = toStateValue(childStateId, delimiter);

      if (isString(childStateValue)) {
        if (isString(parentStateValue)) {
          return childStateValue === parentStateValue;
        } // Parent more specific than child


        return false;
      }

      if (isString(parentStateValue)) {
        return parentStateValue in childStateValue;
      }

      return keys(parentStateValue).every(function (key) {
        if (!(key in childStateValue)) {
          return false;
        }

        return matchesState(parentStateValue[key], childStateValue[key]);
      });
    }

    function getEventType(event) {
      try {
        return isString(event) || typeof event === 'number' ? "" + event : event.type;
      } catch (e) {
        throw new Error('Events must be strings or objects with a string event.type property.');
      }
    }

    function toStatePath(stateId, delimiter) {
      try {
        if (isArray(stateId)) {
          return stateId;
        }

        return stateId.toString().split(delimiter);
      } catch (e) {
        throw new Error("'" + stateId + "' is not a valid state path.");
      }
    }

    function isStateLike(state) {
      return typeof state === 'object' && 'value' in state && 'context' in state && 'event' in state && '_event' in state;
    }

    function toStateValue(stateValue, delimiter) {
      if (isStateLike(stateValue)) {
        return stateValue.value;
      }

      if (isArray(stateValue)) {
        return pathToStateValue(stateValue);
      }

      if (typeof stateValue !== 'string') {
        return stateValue;
      }

      var statePath = toStatePath(stateValue, delimiter);
      return pathToStateValue(statePath);
    }

    function pathToStateValue(statePath) {
      if (statePath.length === 1) {
        return statePath[0];
      }

      var value = {};
      var marker = value;

      for (var i = 0; i < statePath.length - 1; i++) {
        if (i === statePath.length - 2) {
          marker[statePath[i]] = statePath[i + 1];
        } else {
          marker[statePath[i]] = {};
          marker = marker[statePath[i]];
        }
      }

      return value;
    }

    function mapValues(collection, iteratee) {
      var result = {};
      var collectionKeys = keys(collection);

      for (var i = 0; i < collectionKeys.length; i++) {
        var key = collectionKeys[i];
        result[key] = iteratee(collection[key], key, collection, i);
      }

      return result;
    }

    function mapFilterValues(collection, iteratee, predicate) {
      var e_1, _a;

      var result = {};

      try {
        for (var _b = __values(keys(collection)), _c = _b.next(); !_c.done; _c = _b.next()) {
          var key = _c.value;
          var item = collection[key];

          if (!predicate(item)) {
            continue;
          }

          result[key] = iteratee(item, key, collection);
        }
      } catch (e_1_1) {
        e_1 = {
          error: e_1_1
        };
      } finally {
        try {
          if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
        } finally {
          if (e_1) throw e_1.error;
        }
      }

      return result;
    }
    /**
     * Retrieves a value at the given path.
     * @param props The deep path to the prop of the desired value
     */


    var path = function (props) {
      return function (object) {
        var e_2, _a;

        var result = object;

        try {
          for (var props_1 = __values(props), props_1_1 = props_1.next(); !props_1_1.done; props_1_1 = props_1.next()) {
            var prop = props_1_1.value;
            result = result[prop];
          }
        } catch (e_2_1) {
          e_2 = {
            error: e_2_1
          };
        } finally {
          try {
            if (props_1_1 && !props_1_1.done && (_a = props_1.return)) _a.call(props_1);
          } finally {
            if (e_2) throw e_2.error;
          }
        }

        return result;
      };
    };
    /**
     * Retrieves a value at the given path via the nested accessor prop.
     * @param props The deep path to the prop of the desired value
     */


    function nestedPath(props, accessorProp) {
      return function (object) {
        var e_3, _a;

        var result = object;

        try {
          for (var props_2 = __values(props), props_2_1 = props_2.next(); !props_2_1.done; props_2_1 = props_2.next()) {
            var prop = props_2_1.value;
            result = result[accessorProp][prop];
          }
        } catch (e_3_1) {
          e_3 = {
            error: e_3_1
          };
        } finally {
          try {
            if (props_2_1 && !props_2_1.done && (_a = props_2.return)) _a.call(props_2);
          } finally {
            if (e_3) throw e_3.error;
          }
        }

        return result;
      };
    }

    function toStatePaths(stateValue) {
      if (!stateValue) {
        return [[]];
      }

      if (isString(stateValue)) {
        return [[stateValue]];
      }

      var result = flatten(keys(stateValue).map(function (key) {
        var subStateValue = stateValue[key];

        if (typeof subStateValue !== 'string' && (!subStateValue || !Object.keys(subStateValue).length)) {
          return [[key]];
        }

        return toStatePaths(stateValue[key]).map(function (subPath) {
          return [key].concat(subPath);
        });
      }));
      return result;
    }

    function flatten(array) {
      var _a;

      return (_a = []).concat.apply(_a, __spread(array));
    }

    function toArrayStrict(value) {
      if (isArray(value)) {
        return value;
      }

      return [value];
    }

    function toArray(value) {
      if (value === undefined) {
        return [];
      }

      return toArrayStrict(value);
    }

    function mapContext(mapper, context, _event) {
      var e_5, _a;

      if (isFunction(mapper)) {
        return mapper(context, _event.data);
      }

      var result = {};

      try {
        for (var _b = __values(keys(mapper)), _c = _b.next(); !_c.done; _c = _b.next()) {
          var key = _c.value;
          var subMapper = mapper[key];

          if (isFunction(subMapper)) {
            result[key] = subMapper(context, _event.data);
          } else {
            result[key] = subMapper;
          }
        }
      } catch (e_5_1) {
        e_5 = {
          error: e_5_1
        };
      } finally {
        try {
          if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
        } finally {
          if (e_5) throw e_5.error;
        }
      }

      return result;
    }

    function isBuiltInEvent(eventType) {
      return /^(done|error)\./.test(eventType);
    }

    function isPromiseLike(value) {
      if (value instanceof Promise) {
        return true;
      } // Check if shape matches the Promise/A+ specification for a "thenable".


      if (value !== null && (isFunction(value) || typeof value === 'object') && isFunction(value.then)) {
        return true;
      }

      return false;
    }

    function partition(items, predicate) {
      var e_6, _a;

      var _b = __read([[], []], 2),
          truthy = _b[0],
          falsy = _b[1];

      try {
        for (var items_1 = __values(items), items_1_1 = items_1.next(); !items_1_1.done; items_1_1 = items_1.next()) {
          var item = items_1_1.value;

          if (predicate(item)) {
            truthy.push(item);
          } else {
            falsy.push(item);
          }
        }
      } catch (e_6_1) {
        e_6 = {
          error: e_6_1
        };
      } finally {
        try {
          if (items_1_1 && !items_1_1.done && (_a = items_1.return)) _a.call(items_1);
        } finally {
          if (e_6) throw e_6.error;
        }
      }

      return [truthy, falsy];
    }

    function updateHistoryStates(hist, stateValue) {
      return mapValues(hist.states, function (subHist, key) {
        if (!subHist) {
          return undefined;
        }

        var subStateValue = (isString(stateValue) ? undefined : stateValue[key]) || (subHist ? subHist.current : undefined);

        if (!subStateValue) {
          return undefined;
        }

        return {
          current: subStateValue,
          states: updateHistoryStates(subHist, subStateValue)
        };
      });
    }

    function updateHistoryValue(hist, stateValue) {
      return {
        current: stateValue,
        states: updateHistoryStates(hist, stateValue)
      };
    }

    function updateContext(context, _event, assignActions, state) {
      var updatedContext = context ? assignActions.reduce(function (acc, assignAction) {
        var e_7, _a;

        var assignment = assignAction.assignment;
        var meta = {
          state: state,
          action: assignAction,
          _event: _event
        };
        var partialUpdate = {};

        if (isFunction(assignment)) {
          partialUpdate = assignment(acc, _event.data, meta);
        } else {
          try {
            for (var _b = __values(keys(assignment)), _c = _b.next(); !_c.done; _c = _b.next()) {
              var key = _c.value;
              var propAssignment = assignment[key];
              partialUpdate[key] = isFunction(propAssignment) ? propAssignment(acc, _event.data, meta) : propAssignment;
            }
          } catch (e_7_1) {
            e_7 = {
              error: e_7_1
            };
          } finally {
            try {
              if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
            } finally {
              if (e_7) throw e_7.error;
            }
          }
        }

        return Object.assign({}, acc, partialUpdate);
      }, context) : context;
      return updatedContext;
    } // tslint:disable-next-line:no-empty

    function isArray(value) {
      return Array.isArray(value);
    } // tslint:disable-next-line:ban-types


    function isFunction(value) {
      return typeof value === 'function';
    }

    function isString(value) {
      return typeof value === 'string';
    } // export function memoizedGetter<T, TP extends { prototype: object }>(
    //   o: TP,
    //   property: string,
    //   getter: () => T
    // ): void {
    //   Object.defineProperty(o.prototype, property, {
    //     get: getter,
    //     enumerable: false,
    //     configurable: false
    //   });
    // }


    function toGuard(condition, guardMap) {
      if (!condition) {
        return undefined;
      }

      if (isString(condition)) {
        return {
          type: DEFAULT_GUARD_TYPE,
          name: condition,
          predicate: guardMap ? guardMap[condition] : undefined
        };
      }

      if (isFunction(condition)) {
        return {
          type: DEFAULT_GUARD_TYPE,
          name: condition.name,
          predicate: condition
        };
      }

      return condition;
    }

    function isObservable(value) {
      try {
        return 'subscribe' in value && isFunction(value.subscribe);
      } catch (e) {
        return false;
      }
    }

    function isMachine(value) {
      try {
        return '__xstatenode' in value;
      } catch (e) {
        return false;
      }
    }

    function toEventObject(event, payload // id?: TEvent['type']
    ) {
      if (isString(event) || typeof event === 'number') {
        return __assign({
          type: event
        }, payload);
      }

      return event;
    }

    function toSCXMLEvent(event, scxmlEvent) {
      if (!isString(event) && '$$type' in event && event.$$type === 'scxml') {
        return event;
      }

      var eventObject = toEventObject(event);
      return __assign({
        name: eventObject.type,
        data: eventObject,
        $$type: 'scxml',
        type: 'external'
      }, scxmlEvent);
    }

    function toTransitionConfigArray(event, configLike) {
      var transitions = toArrayStrict(configLike).map(function (transitionLike) {
        if (typeof transitionLike === 'undefined' || typeof transitionLike === 'string' || isMachine(transitionLike)) {
          return {
            target: transitionLike,
            event: event
          };
        }

        return __assign(__assign({}, transitionLike), {
          event: event
        });
      });
      return transitions;
    }

    function normalizeTarget(target) {
      if (target === undefined || target === TARGETLESS_KEY) {
        return undefined;
      }

      return toArray(target);
    }

    var ActionTypes;

    (function (ActionTypes) {
      ActionTypes["Start"] = "xstate.start";
      ActionTypes["Stop"] = "xstate.stop";
      ActionTypes["Raise"] = "xstate.raise";
      ActionTypes["Send"] = "xstate.send";
      ActionTypes["Cancel"] = "xstate.cancel";
      ActionTypes["NullEvent"] = "";
      ActionTypes["Assign"] = "xstate.assign";
      ActionTypes["After"] = "xstate.after";
      ActionTypes["DoneState"] = "done.state";
      ActionTypes["DoneInvoke"] = "done.invoke";
      ActionTypes["Log"] = "xstate.log";
      ActionTypes["Init"] = "xstate.init";
      ActionTypes["Invoke"] = "xstate.invoke";
      ActionTypes["ErrorExecution"] = "error.execution";
      ActionTypes["ErrorCommunication"] = "error.communication";
      ActionTypes["ErrorPlatform"] = "error.platform";
      ActionTypes["Update"] = "xstate.update";
      ActionTypes["Pure"] = "xstate.pure";
    })(ActionTypes || (ActionTypes = {}));

    var SpecialTargets;

    (function (SpecialTargets) {
      SpecialTargets["Parent"] = "#_parent";
      SpecialTargets["Internal"] = "#_internal";
    })(SpecialTargets || (SpecialTargets = {}));

    var start = ActionTypes.Start;
    var stop = ActionTypes.Stop;
    var raise = ActionTypes.Raise;
    var send = ActionTypes.Send;
    var cancel = ActionTypes.Cancel;
    var nullEvent = ActionTypes.NullEvent;
    var assign$1 = ActionTypes.Assign;
    var after = ActionTypes.After;
    var doneState = ActionTypes.DoneState;
    var log = ActionTypes.Log;
    var init$1 = ActionTypes.Init;
    var invoke = ActionTypes.Invoke;
    var errorExecution = ActionTypes.ErrorExecution;
    var errorPlatform = ActionTypes.ErrorPlatform;
    var update$1 = ActionTypes.Update;

    var initEvent =
    /*#__PURE__*/
    toSCXMLEvent({
      type: init$1
    });

    function getActionFunction(actionType, actionFunctionMap) {
      return actionFunctionMap ? actionFunctionMap[actionType] || undefined : undefined;
    }

    function toActionObject(action, actionFunctionMap) {
      var actionObject;

      if (isString(action) || typeof action === 'number') {
        var exec = getActionFunction(action, actionFunctionMap);

        if (isFunction(exec)) {
          actionObject = {
            type: action,
            exec: exec
          };
        } else if (exec) {
          actionObject = exec;
        } else {
          actionObject = {
            type: action,
            exec: undefined
          };
        }
      } else if (isFunction(action)) {
        actionObject = {
          // Convert action to string if unnamed
          type: action.name || action.toString(),
          exec: action
        };
      } else {
        var exec = getActionFunction(action.type, actionFunctionMap);

        if (isFunction(exec)) {
          actionObject = __assign(__assign({}, action), {
            exec: exec
          });
        } else if (exec) {
          var type = action.type,
              other = __rest(action, ["type"]);

          actionObject = __assign(__assign({
            type: type
          }, exec), other);
        } else {
          actionObject = action;
        }
      }

      Object.defineProperty(actionObject, 'toString', {
        value: function () {
          return actionObject.type;
        },
        enumerable: false,
        configurable: true
      });
      return actionObject;
    }

    var toActionObjects = function (action, actionFunctionMap) {
      if (!action) {
        return [];
      }

      var actions = isArray(action) ? action : [action];
      return actions.map(function (subAction) {
        return toActionObject(subAction, actionFunctionMap);
      });
    };

    function toActivityDefinition(action) {
      var actionObject = toActionObject(action);
      return __assign(__assign({
        id: isString(action) ? action : actionObject.id
      }, actionObject), {
        type: actionObject.type
      });
    }
    /**
     * Raises an event. This places the event in the internal event queue, so that
     * the event is immediately consumed by the machine in the current step.
     *
     * @param eventType The event to raise.
     */


    function raise$1(event) {
      if (!isString(event)) {
        return send$1(event, {
          to: SpecialTargets.Internal
        });
      }

      return {
        type: raise,
        event: event
      };
    }

    function resolveRaise(action) {
      return {
        type: raise,
        _event: toSCXMLEvent(action.event)
      };
    }
    /**
     * Sends an event. This returns an action that will be read by an interpreter to
     * send the event in the next step, after the current step is finished executing.
     *
     * @param event The event to send.
     * @param options Options to pass into the send event:
     *  - `id` - The unique send event identifier (used with `cancel()`).
     *  - `delay` - The number of milliseconds to delay the sending of the event.
     *  - `target` - The target of this event (by default, the machine the event was sent from).
     */


    function send$1(event, options) {
      return {
        to: options ? options.to : undefined,
        type: send,
        event: isFunction(event) ? event : toEventObject(event),
        delay: options ? options.delay : undefined,
        id: options && options.id !== undefined ? options.id : isFunction(event) ? event.name : getEventType(event)
      };
    }

    function resolveSend(action, ctx, _event, delaysMap) {
      var meta = {
        _event: _event
      }; // TODO: helper function for resolving Expr

      var resolvedEvent = toSCXMLEvent(isFunction(action.event) ? action.event(ctx, _event.data, meta) : action.event);
      var resolvedDelay;

      if (isString(action.delay)) {
        var configDelay = delaysMap && delaysMap[action.delay];
        resolvedDelay = isFunction(configDelay) ? configDelay(ctx, _event.data, meta) : configDelay;
      } else {
        resolvedDelay = isFunction(action.delay) ? action.delay(ctx, _event.data, meta) : action.delay;
      }

      var resolvedTarget = isFunction(action.to) ? action.to(ctx, _event.data, meta) : action.to;
      return __assign(__assign({}, action), {
        to: resolvedTarget,
        _event: resolvedEvent,
        event: resolvedEvent.data,
        delay: resolvedDelay
      });
    }
    /**
     * Sends an event to this machine's parent.
     *
     * @param event The event to send to the parent machine.
     * @param options Options to pass into the send event.
     */


    function sendParent(event, options) {
      return send$1(event, __assign(__assign({}, options), {
        to: SpecialTargets.Parent
      }));
    }
    /**
     * Sends an event back to the sender of the original event.
     *
     * @param event The event to send back to the sender
     * @param options Options to pass into the send event
     */


    function respond(event, options) {
      return send$1(event, __assign(__assign({}, options), {
        to: function (_, __, _a) {
          var _event = _a._event;
          return _event.origin; // TODO: handle when _event.origin is undefined
        }
      }));
    }

    var defaultLogExpr = function (context, event) {
      return {
        context: context,
        event: event
      };
    };
    /**
     *
     * @param expr The expression function to evaluate which will be logged.
     *  Takes in 2 arguments:
     *  - `ctx` - the current state context
     *  - `event` - the event that caused this action to be executed.
     * @param label The label to give to the logged expression.
     */


    function log$1(expr, label) {
      if (expr === void 0) {
        expr = defaultLogExpr;
      }

      return {
        type: log,
        label: label,
        expr: expr
      };
    }

    var resolveLog = function (action, ctx, _event) {
      return __assign(__assign({}, action), {
        value: isString(action.expr) ? action.expr : action.expr(ctx, _event.data, {
          _event: _event
        })
      });
    };
    /**
     * Cancels an in-flight `send(...)` action. A canceled sent action will not
     * be executed, nor will its event be sent, unless it has already been sent
     * (e.g., if `cancel(...)` is called after the `send(...)` action's `delay`).
     *
     * @param sendId The `id` of the `send(...)` action to cancel.
     */


    var cancel$1 = function (sendId) {
      return {
        type: cancel,
        sendId: sendId
      };
    };
    /**
     * Starts an activity.
     *
     * @param activity The activity to start.
     */


    function start$1(activity) {
      var activityDef = toActivityDefinition(activity);
      return {
        type: ActionTypes.Start,
        activity: activityDef,
        exec: undefined
      };
    }
    /**
     * Stops an activity.
     *
     * @param activity The activity to stop.
     */


    function stop$1(activity) {
      var activityDef = toActivityDefinition(activity);
      return {
        type: ActionTypes.Stop,
        activity: activityDef,
        exec: undefined
      };
    }
    /**
     * Updates the current context of the machine.
     *
     * @param assignment An object that represents the partial context to update.
     */


    var assign$2 = function (assignment) {
      return {
        type: assign$1,
        assignment: assignment
      };
    };
    /**
     * Returns an event type that represents an implicit event that
     * is sent after the specified `delay`.
     *
     * @param delayRef The delay in milliseconds
     * @param id The state node ID where this event is handled
     */


    function after$1(delayRef, id) {
      var idSuffix = id ? "#" + id : '';
      return ActionTypes.After + "(" + delayRef + ")" + idSuffix;
    }
    /**
     * Returns an event that represents that a final state node
     * has been reached in the parent state node.
     *
     * @param id The final state node's parent state node `id`
     * @param data The data to pass into the event
     */


    function done(id, data) {
      var type = ActionTypes.DoneState + "." + id;
      var eventObject = {
        type: type,
        data: data
      };

      eventObject.toString = function () {
        return type;
      };

      return eventObject;
    }
    /**
     * Returns an event that represents that an invoked service has terminated.
     *
     * An invoked service is terminated when it has reached a top-level final state node,
     * but not when it is canceled.
     *
     * @param id The final state node ID
     * @param data The data to pass into the event
     */


    function doneInvoke(id, data) {
      var type = ActionTypes.DoneInvoke + "." + id;
      var eventObject = {
        type: type,
        data: data
      };

      eventObject.toString = function () {
        return type;
      };

      return eventObject;
    }

    function error(id, data) {
      var type = ActionTypes.ErrorPlatform + "." + id;
      var eventObject = {
        type: type,
        data: data
      };

      eventObject.toString = function () {
        return type;
      };

      return eventObject;
    }

    var isLeafNode = function (stateNode) {
      return stateNode.type === 'atomic' || stateNode.type === 'final';
    };

    function getChildren(stateNode) {
      return keys(stateNode.states).map(function (key) {
        return stateNode.states[key];
      });
    }

    function getAllStateNodes(stateNode) {
      var stateNodes = [stateNode];

      if (isLeafNode(stateNode)) {
        return stateNodes;
      }

      return stateNodes.concat(flatten(getChildren(stateNode).map(getAllStateNodes)));
    }

    function getConfiguration(prevStateNodes, stateNodes) {
      var e_1, _a, e_2, _b, e_3, _c, e_4, _d;

      var prevConfiguration = new Set(prevStateNodes);
      var prevAdjList = getAdjList(prevConfiguration);
      var configuration = new Set(stateNodes);

      try {
        // add all ancestors
        for (var configuration_1 = __values(configuration), configuration_1_1 = configuration_1.next(); !configuration_1_1.done; configuration_1_1 = configuration_1.next()) {
          var s = configuration_1_1.value;
          var m = s.parent;

          while (m && !configuration.has(m)) {
            configuration.add(m);
            m = m.parent;
          }
        }
      } catch (e_1_1) {
        e_1 = {
          error: e_1_1
        };
      } finally {
        try {
          if (configuration_1_1 && !configuration_1_1.done && (_a = configuration_1.return)) _a.call(configuration_1);
        } finally {
          if (e_1) throw e_1.error;
        }
      }

      var adjList = getAdjList(configuration);

      try {
        // add descendants
        for (var configuration_2 = __values(configuration), configuration_2_1 = configuration_2.next(); !configuration_2_1.done; configuration_2_1 = configuration_2.next()) {
          var s = configuration_2_1.value; // if previously active, add existing child nodes

          if (s.type === 'compound' && (!adjList.get(s) || !adjList.get(s).length)) {
            if (prevAdjList.get(s)) {
              prevAdjList.get(s).forEach(function (sn) {
                return configuration.add(sn);
              });
            } else {
              s.initialStateNodes.forEach(function (sn) {
                return configuration.add(sn);
              });
            }
          } else {
            if (s.type === 'parallel') {
              try {
                for (var _e = (e_3 = void 0, __values(getChildren(s))), _f = _e.next(); !_f.done; _f = _e.next()) {
                  var child = _f.value;

                  if (child.type === 'history') {
                    continue;
                  }

                  if (!configuration.has(child)) {
                    configuration.add(child);

                    if (prevAdjList.get(child)) {
                      prevAdjList.get(child).forEach(function (sn) {
                        return configuration.add(sn);
                      });
                    } else {
                      child.initialStateNodes.forEach(function (sn) {
                        return configuration.add(sn);
                      });
                    }
                  }
                }
              } catch (e_3_1) {
                e_3 = {
                  error: e_3_1
                };
              } finally {
                try {
                  if (_f && !_f.done && (_c = _e.return)) _c.call(_e);
                } finally {
                  if (e_3) throw e_3.error;
                }
              }
            }
          }
        }
      } catch (e_2_1) {
        e_2 = {
          error: e_2_1
        };
      } finally {
        try {
          if (configuration_2_1 && !configuration_2_1.done && (_b = configuration_2.return)) _b.call(configuration_2);
        } finally {
          if (e_2) throw e_2.error;
        }
      }

      try {
        // add all ancestors
        for (var configuration_3 = __values(configuration), configuration_3_1 = configuration_3.next(); !configuration_3_1.done; configuration_3_1 = configuration_3.next()) {
          var s = configuration_3_1.value;
          var m = s.parent;

          while (m && !configuration.has(m)) {
            configuration.add(m);
            m = m.parent;
          }
        }
      } catch (e_4_1) {
        e_4 = {
          error: e_4_1
        };
      } finally {
        try {
          if (configuration_3_1 && !configuration_3_1.done && (_d = configuration_3.return)) _d.call(configuration_3);
        } finally {
          if (e_4) throw e_4.error;
        }
      }

      return configuration;
    }

    function getValueFromAdj(baseNode, adjList) {
      var childStateNodes = adjList.get(baseNode);

      if (!childStateNodes) {
        return {}; // todo: fix?
      }

      if (baseNode.type === 'compound') {
        var childStateNode = childStateNodes[0];

        if (childStateNode) {
          if (isLeafNode(childStateNode)) {
            return childStateNode.key;
          }
        } else {
          return {};
        }
      }

      var stateValue = {};
      childStateNodes.forEach(function (csn) {
        stateValue[csn.key] = getValueFromAdj(csn, adjList);
      });
      return stateValue;
    }

    function getAdjList(configuration) {
      var e_5, _a;

      var adjList = new Map();

      try {
        for (var configuration_4 = __values(configuration), configuration_4_1 = configuration_4.next(); !configuration_4_1.done; configuration_4_1 = configuration_4.next()) {
          var s = configuration_4_1.value;

          if (!adjList.has(s)) {
            adjList.set(s, []);
          }

          if (s.parent) {
            if (!adjList.has(s.parent)) {
              adjList.set(s.parent, []);
            }

            adjList.get(s.parent).push(s);
          }
        }
      } catch (e_5_1) {
        e_5 = {
          error: e_5_1
        };
      } finally {
        try {
          if (configuration_4_1 && !configuration_4_1.done && (_a = configuration_4.return)) _a.call(configuration_4);
        } finally {
          if (e_5) throw e_5.error;
        }
      }

      return adjList;
    }

    function getValue(rootNode, configuration) {
      var config = getConfiguration([rootNode], configuration);
      return getValueFromAdj(rootNode, getAdjList(config));
    }

    function has(iterable, item) {
      if (Array.isArray(iterable)) {
        return iterable.some(function (member) {
          return member === item;
        });
      }

      if (iterable instanceof Set) {
        return iterable.has(item);
      }

      return false; // TODO: fix
    }

    function nextEvents(configuration) {
      return flatten(__spread(new Set(configuration.map(function (sn) {
        return sn.ownEvents;
      }))));
    }

    function isInFinalState(configuration, stateNode) {
      if (stateNode.type === 'compound') {
        return getChildren(stateNode).some(function (s) {
          return s.type === 'final' && has(configuration, s);
        });
      }

      if (stateNode.type === 'parallel') {
        return getChildren(stateNode).every(function (sn) {
          return isInFinalState(configuration, sn);
        });
      }

      return false;
    }

    function stateValuesEqual(a, b) {
      if (a === b) {
        return true;
      }

      if (a === undefined || b === undefined) {
        return false;
      }

      if (isString(a) || isString(b)) {
        return a === b;
      }

      var aKeys = keys(a);
      var bKeys = keys(b);
      return aKeys.length === bKeys.length && aKeys.every(function (key) {
        return stateValuesEqual(a[key], b[key]);
      });
    }

    function isState(state) {
      if (isString(state)) {
        return false;
      }

      return 'value' in state && 'history' in state;
    }

    function bindActionToState(action, state) {
      var exec = action.exec;

      var boundAction = __assign(__assign({}, action), {
        exec: exec !== undefined ? function () {
          return exec(state.context, state.event, {
            action: action,
            state: state,
            _event: state._event
          });
        } : undefined
      });

      return boundAction;
    }

    var State =
    /*#__PURE__*/

    /** @class */
    function () {
      /**
       * Creates a new State instance.
       * @param value The state value
       * @param context The extended state
       * @param historyValue The tree representing historical values of the state nodes
       * @param history The previous state
       * @param actions An array of action objects to execute as side-effects
       * @param activities A mapping of activities and whether they are started (`true`) or stopped (`false`).
       * @param meta
       * @param events Internal event queue. Should be empty with run-to-completion semantics.
       * @param configuration
       */
      function State(config) {
        this.actions = [];
        this.activities = EMPTY_ACTIVITY_MAP;
        this.meta = {};
        this.events = [];
        this.value = config.value;
        this.context = config.context;
        this._event = config._event;
        this.event = this._event.data;
        this.historyValue = config.historyValue;
        this.history = config.history;
        this.actions = config.actions || [];
        this.activities = config.activities || EMPTY_ACTIVITY_MAP;
        this.meta = config.meta || {};
        this.events = config.events || [];
        this.matches = this.matches.bind(this);
        this.toStrings = this.toStrings.bind(this);
        this.configuration = config.configuration;
        this.transitions = config.transitions;
        this.children = config.children;
        Object.defineProperty(this, 'nextEvents', {
          get: function () {
            return nextEvents(config.configuration);
          }
        });
      }
      /**
       * Creates a new State instance for the given `stateValue` and `context`.
       * @param stateValue
       * @param context
       */


      State.from = function (stateValue, context) {
        if (stateValue instanceof State) {
          if (stateValue.context !== context) {
            return new State({
              value: stateValue.value,
              context: context,
              _event: stateValue._event,
              historyValue: stateValue.historyValue,
              history: stateValue.history,
              actions: [],
              activities: stateValue.activities,
              meta: {},
              events: [],
              configuration: [],
              transitions: [],
              children: {}
            });
          }

          return stateValue;
        }

        var _event = initEvent;
        return new State({
          value: stateValue,
          context: context,
          _event: _event,
          historyValue: undefined,
          history: undefined,
          actions: [],
          activities: undefined,
          meta: undefined,
          events: [],
          configuration: [],
          transitions: [],
          children: {}
        });
      };
      /**
       * Creates a new State instance for the given `config`.
       * @param config The state config
       */


      State.create = function (config) {
        return new State(config);
      };
      /**
       * Creates a new `State` instance for the given `stateValue` and `context` with no actions (side-effects).
       * @param stateValue
       * @param context
       */


      State.inert = function (stateValue, context) {
        if (stateValue instanceof State) {
          if (!stateValue.actions.length) {
            return stateValue;
          }

          var _event = initEvent;
          return new State({
            value: stateValue.value,
            context: context,
            _event: _event,
            historyValue: stateValue.historyValue,
            history: stateValue.history,
            activities: stateValue.activities,
            configuration: stateValue.configuration,
            transitions: [],
            children: {}
          });
        }

        return State.from(stateValue, context);
      };
      /**
       * Returns an array of all the string leaf state node paths.
       * @param stateValue
       * @param delimiter The character(s) that separate each subpath in the string state node path.
       */


      State.prototype.toStrings = function (stateValue, delimiter) {
        var _this = this;

        if (stateValue === void 0) {
          stateValue = this.value;
        }

        if (delimiter === void 0) {
          delimiter = '.';
        }

        if (isString(stateValue)) {
          return [stateValue];
        }

        var valueKeys = keys(stateValue);
        return valueKeys.concat.apply(valueKeys, __spread(valueKeys.map(function (key) {
          return _this.toStrings(stateValue[key], delimiter).map(function (s) {
            return key + delimiter + s;
          });
        })));
      };

      State.prototype.toJSON = function () {
        var _a = this,
            configuration = _a.configuration,
            transitions = _a.transitions,
            jsonValues = __rest(_a, ["configuration", "transitions"]);

        return jsonValues;
      };
      /**
       * Whether the current state value is a subset of the given parent state value.
       * @param parentStateValue
       */


      State.prototype.matches = function (parentStateValue) {
        return matchesState(parentStateValue, this.value);
      };

      return State;
    }();

    function createNullActor(id) {
      return {
        id: id,
        send: function () {
          return void 0;
        },
        subscribe: function () {
          return {
            unsubscribe: function () {
              return void 0;
            }
          };
        },
        toJSON: function () {
          return {
            id: id
          };
        }
      };
    }
    /**
     * Creates a null actor that is able to be invoked given the provided
     * invocation information in its `.meta` value.
     *
     * @param invokeDefinition The meta information needed to invoke the actor.
     */


    function createInvocableActor(invokeDefinition) {
      var tempActor = createNullActor(invokeDefinition.id);
      tempActor.meta = invokeDefinition;
      return tempActor;
    }

    function isActor(item) {
      try {
        return typeof item.send === 'function';
      } catch (e) {
        return false;
      }
    }

    var NULL_EVENT = '';
    var STATE_IDENTIFIER = '#';
    var WILDCARD = '*';
    var EMPTY_OBJECT = {};

    var isStateId = function (str) {
      return str[0] === STATE_IDENTIFIER;
    };

    var createDefaultOptions = function () {
      return {
        actions: {},
        guards: {},
        services: {},
        activities: {},
        delays: {}
      };
    };

    var StateNode =
    /*#__PURE__*/

    /** @class */
    function () {
      function StateNode(_config, options,
      /**
       * The initial extended state
       */
      context) {
        var _this = this;

        this.context = context;
        /**
         * The order this state node appears. Corresponds to the implicit SCXML document order.
         */

        this.order = -1;
        this.__xstatenode = true;
        this.__cache = {
          events: undefined,
          relativeValue: new Map(),
          initialStateValue: undefined,
          initialState: undefined,
          on: undefined,
          transitions: undefined,
          candidates: {},
          delayedTransitions: undefined
        };
        this.idMap = {};

        var parent = _config.parent,
            config = __rest(_config, ["parent"]);

        this.config = config;
        this.parent = parent;
        this.options = __assign(__assign({}, createDefaultOptions()), options);
        this.key = _config.key || _config.id || '(machine)';
        this.machine = this.parent ? this.parent.machine : this;
        this.path = this.parent ? this.parent.path.concat(this.key) : [];
        this.delimiter = _config.delimiter || (this.parent ? this.parent.delimiter : STATE_DELIMITER);
        this.id = _config.id || __spread([this.machine.key], this.path).join(this.delimiter);
        this.version = this.parent ? this.parent.version : _config.version;
        this.type = _config.type || (_config.parallel ? 'parallel' : _config.states && keys(_config.states).length ? 'compound' : _config.history ? 'history' : 'atomic');

        this.initial = _config.initial;
        this.states = _config.states ? mapValues(_config.states, function (stateConfig, key) {
          var _a;

          var stateNode = new StateNode(__assign(__assign({}, stateConfig), {
            key: key,
            parent: _this
          }));
          Object.assign(_this.idMap, __assign((_a = {}, _a[stateNode.id] = stateNode, _a), stateNode.idMap));
          return stateNode;
        }) : EMPTY_OBJECT; // Document order

        var order = 0;

        function dfs(sn) {
          var e_1, _a;

          sn.order = order++;

          try {
            for (var _b = __values(getChildren(sn)), _c = _b.next(); !_c.done; _c = _b.next()) {
              var child = _c.value;
              dfs(child);
            }
          } catch (e_1_1) {
            e_1 = {
              error: e_1_1
            };
          } finally {
            try {
              if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
            } finally {
              if (e_1) throw e_1.error;
            }
          }
        }

        dfs(this); // History config

        this.history = _config.history === true ? 'shallow' : _config.history || false;
        this._transient = !_config.on ? false : Array.isArray(_config.on) ? _config.on.some(function (_a) {
          var event = _a.event;
          return event === NULL_EVENT;
        }) : NULL_EVENT in _config.on;
        this.strict = !!_config.strict; // TODO: deprecate (entry)

        this.onEntry = toArray(_config.entry || _config.onEntry).map(function (action) {
          return toActionObject(action);
        }); // TODO: deprecate (exit)

        this.onExit = toArray(_config.exit || _config.onExit).map(function (action) {
          return toActionObject(action);
        });
        this.meta = _config.meta;
        this.data = this.type === 'final' ? _config.data : undefined;
        this.invoke = toArray(_config.invoke).map(function (invokeConfig, i) {
          var _a, _b;

          if (isMachine(invokeConfig)) {
            _this.machine.options.services = __assign((_a = {}, _a[invokeConfig.id] = invokeConfig, _a), _this.machine.options.services);
            return {
              type: invoke,
              src: invokeConfig.id,
              id: invokeConfig.id
            };
          } else if (typeof invokeConfig.src !== 'string') {
            var invokeSrc = _this.id + ":invocation[" + i + "]"; // TODO: util function

            _this.machine.options.services = __assign((_b = {}, _b[invokeSrc] = invokeConfig.src, _b), _this.machine.options.services);
            return __assign(__assign({
              type: invoke,
              id: invokeSrc
            }, invokeConfig), {
              src: invokeSrc
            });
          } else {
            return __assign(__assign({}, invokeConfig), {
              type: invoke,
              id: invokeConfig.id || invokeConfig.src,
              src: invokeConfig.src
            });
          }
        });
        this.activities = toArray(_config.activities).concat(this.invoke).map(function (activity) {
          return toActivityDefinition(activity);
        });
        this.transition = this.transition.bind(this);
      }

      StateNode.prototype._init = function () {
        if (this.__cache.transitions) {
          return;
        }

        getAllStateNodes(this).forEach(function (stateNode) {
          return stateNode.on;
        });
      };
      /**
       * Clones this state machine with custom options and context.
       *
       * @param options Options (actions, guards, activities, services) to recursively merge with the existing options.
       * @param context Custom context (will override predefined context)
       */


      StateNode.prototype.withConfig = function (options, context) {
        if (context === void 0) {
          context = this.context;
        }

        var _a = this.options,
            actions = _a.actions,
            activities = _a.activities,
            guards = _a.guards,
            services = _a.services,
            delays = _a.delays;
        return new StateNode(this.config, {
          actions: __assign(__assign({}, actions), options.actions),
          activities: __assign(__assign({}, activities), options.activities),
          guards: __assign(__assign({}, guards), options.guards),
          services: __assign(__assign({}, services), options.services),
          delays: __assign(__assign({}, delays), options.delays)
        }, context);
      };
      /**
       * Clones this state machine with custom context.
       *
       * @param context Custom context (will override predefined context, not recursive)
       */


      StateNode.prototype.withContext = function (context) {
        return new StateNode(this.config, this.options, context);
      };

      Object.defineProperty(StateNode.prototype, "definition", {
        /**
         * The well-structured state node definition.
         */
        get: function () {
          return {
            id: this.id,
            key: this.key,
            version: this.version,
            type: this.type,
            initial: this.initial,
            history: this.history,
            states: mapValues(this.states, function (state) {
              return state.definition;
            }),
            on: this.on,
            transitions: this.transitions,
            onEntry: this.onEntry,
            onExit: this.onExit,
            activities: this.activities || [],
            meta: this.meta,
            order: this.order || -1,
            data: this.data,
            invoke: this.invoke
          };
        },
        enumerable: true,
        configurable: true
      });

      StateNode.prototype.toJSON = function () {
        return this.definition;
      };

      Object.defineProperty(StateNode.prototype, "on", {
        /**
         * The mapping of events to transitions.
         */
        get: function () {
          if (this.__cache.on) {
            return this.__cache.on;
          }

          var transitions = this.transitions;
          return this.__cache.on = transitions.reduce(function (map, transition) {
            map[transition.eventType] = map[transition.eventType] || [];
            map[transition.eventType].push(transition);
            return map;
          }, {});
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(StateNode.prototype, "after", {
        get: function () {
          return this.__cache.delayedTransitions || (this.__cache.delayedTransitions = this.getDelayedTransitions(), this.__cache.delayedTransitions);
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(StateNode.prototype, "transitions", {
        /**
         * All the transitions that can be taken from this state node.
         */
        get: function () {
          return this.__cache.transitions || (this.__cache.transitions = this.formatTransitions(), this.__cache.transitions);
        },
        enumerable: true,
        configurable: true
      });

      StateNode.prototype.getCandidates = function (eventName) {
        if (this.__cache.candidates[eventName]) {
          return this.__cache.candidates[eventName];
        }

        var transient = eventName === NULL_EVENT;
        var candidates = this.transitions.filter(function (transition) {
          var sameEventType = transition.eventType === eventName; // null events should only match against eventless transitions

          return transient ? sameEventType : sameEventType || transition.eventType === WILDCARD;
        });
        this.__cache.candidates[eventName] = candidates;
        return candidates;
      };
      /**
       * All delayed transitions from the config.
       */


      StateNode.prototype.getDelayedTransitions = function () {
        var _this = this;

        var afterConfig = this.config.after;

        if (!afterConfig) {
          return [];
        }

        var delayedTransitions = isArray(afterConfig) ? afterConfig : flatten(keys(afterConfig).map(function (delay) {
          var configTransition = afterConfig[delay];
          var resolvedTransition = isString(configTransition) ? {
            target: configTransition
          } : configTransition;
          return toArray(resolvedTransition).map(function (transition) {
            return __assign(__assign({}, transition), {
              delay: !isNaN(+delay) ? +delay : delay
            });
          });
        }));
        return delayedTransitions.map(function (delayedTransition, i) {
          var _a;

          var delay = delayedTransition.delay;
          var delayRef;

          if (isFunction(delay)) {
            // TODO: util function
            delayRef = _this.id + ":delay[" + i + "]";
            _this.machine.options.delays = __assign(__assign({}, _this.machine.options.delays), (_a = {}, _a[delayRef] = delay, _a));
          } else {
            delayRef = delay;
          }

          var eventType = after$1(delayRef, _this.id);

          _this.onEntry.push(send$1(eventType, {
            delay: delayRef
          }));

          _this.onExit.push(cancel$1(eventType));

          return __assign(__assign({}, _this.formatTransition(__assign(__assign({}, delayedTransition), {
            event: eventType
          }))), {
            delay: delay
          });
        });
      };
      /**
       * Returns the state nodes represented by the current state value.
       *
       * @param state The state value or State instance
       */


      StateNode.prototype.getStateNodes = function (state) {
        var _a;

        var _this = this;

        if (!state) {
          return [];
        }

        var stateValue = state instanceof State ? state.value : toStateValue(state, this.delimiter);

        if (isString(stateValue)) {
          var initialStateValue = this.getStateNode(stateValue).initial;
          return initialStateValue !== undefined ? this.getStateNodes((_a = {}, _a[stateValue] = initialStateValue, _a)) : [this.states[stateValue]];
        }

        var subStateKeys = keys(stateValue);
        var subStateNodes = subStateKeys.map(function (subStateKey) {
          return _this.getStateNode(subStateKey);
        });
        return subStateNodes.concat(subStateKeys.reduce(function (allSubStateNodes, subStateKey) {
          var subStateNode = _this.getStateNode(subStateKey).getStateNodes(stateValue[subStateKey]);

          return allSubStateNodes.concat(subStateNode);
        }, []));
      };
      /**
       * Returns `true` if this state node explicitly handles the given event.
       *
       * @param event The event in question
       */


      StateNode.prototype.handles = function (event) {
        var eventType = getEventType(event);
        return this.events.indexOf(eventType) !== -1;
      };
      /**
       * Resolves the given `state` to a new `State` instance relative to this machine.
       *
       * This ensures that `.events` and `.nextEvents` represent the correct values.
       *
       * @param state The state to resolve
       */


      StateNode.prototype.resolveState = function (state) {
        var configuration = Array.from(getConfiguration([], this.getStateNodes(state.value)));
        return new State(__assign(__assign({}, state), {
          value: this.resolve(state.value),
          configuration: configuration
        }));
      };

      StateNode.prototype.transitionLeafNode = function (stateValue, state, _event) {
        var stateNode = this.getStateNode(stateValue);
        var next = stateNode.next(state, _event);

        if (!next || !next.transitions.length) {
          return this.next(state, _event);
        }

        return next;
      };

      StateNode.prototype.transitionCompoundNode = function (stateValue, state, _event) {
        var subStateKeys = keys(stateValue);
        var stateNode = this.getStateNode(subStateKeys[0]);

        var next = stateNode._transition(stateValue[subStateKeys[0]], state, _event);

        if (!next || !next.transitions.length) {
          return this.next(state, _event);
        }

        return next;
      };

      StateNode.prototype.transitionParallelNode = function (stateValue, state, _event) {
        var e_2, _a;

        var transitionMap = {};

        try {
          for (var _b = __values(keys(stateValue)), _c = _b.next(); !_c.done; _c = _b.next()) {
            var subStateKey = _c.value;
            var subStateValue = stateValue[subStateKey];

            if (!subStateValue) {
              continue;
            }

            var subStateNode = this.getStateNode(subStateKey);

            var next = subStateNode._transition(subStateValue, state, _event);

            if (next) {
              transitionMap[subStateKey] = next;
            }
          }
        } catch (e_2_1) {
          e_2 = {
            error: e_2_1
          };
        } finally {
          try {
            if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
          } finally {
            if (e_2) throw e_2.error;
          }
        }

        var stateTransitions = keys(transitionMap).map(function (key) {
          return transitionMap[key];
        });
        var enabledTransitions = flatten(stateTransitions.map(function (st) {
          return st.transitions;
        }));
        var willTransition = stateTransitions.some(function (st) {
          return st.transitions.length > 0;
        });

        if (!willTransition) {
          return this.next(state, _event);
        }

        var entryNodes = flatten(stateTransitions.map(function (t) {
          return t.entrySet;
        }));
        var configuration = flatten(keys(transitionMap).map(function (key) {
          return transitionMap[key].configuration;
        }));
        return {
          transitions: enabledTransitions,
          entrySet: entryNodes,
          exitSet: flatten(stateTransitions.map(function (t) {
            return t.exitSet;
          })),
          configuration: configuration,
          source: state,
          actions: flatten(keys(transitionMap).map(function (key) {
            return transitionMap[key].actions;
          }))
        };
      };

      StateNode.prototype._transition = function (stateValue, state, _event) {
        // leaf node
        if (isString(stateValue)) {
          return this.transitionLeafNode(stateValue, state, _event);
        } // hierarchical node


        if (keys(stateValue).length === 1) {
          return this.transitionCompoundNode(stateValue, state, _event);
        } // orthogonal node


        return this.transitionParallelNode(stateValue, state, _event);
      };

      StateNode.prototype.next = function (state, _event) {
        var e_3, _a;

        var _this = this;

        var eventName = _event.name;
        var actions = [];
        var nextStateNodes = [];
        var selectedTransition;

        try {
          for (var _b = __values(this.getCandidates(eventName)), _c = _b.next(); !_c.done; _c = _b.next()) {
            var candidate = _c.value;
            var cond = candidate.cond,
                stateIn = candidate.in;
            var resolvedContext = state.context;
            var isInState = stateIn ? isString(stateIn) && isStateId(stateIn) ? // Check if in state by ID
            state.matches(toStateValue(this.getStateNodeById(stateIn).path, this.delimiter)) : // Check if in state by relative grandparent
            matchesState(toStateValue(stateIn, this.delimiter), path(this.path.slice(0, -2))(state.value)) : true;
            var guardPassed = false;

            try {
              guardPassed = !cond || this.evaluateGuard(cond, resolvedContext, _event, state);
            } catch (err) {
              throw new Error("Unable to evaluate guard '" + (cond.name || cond.type) + "' in transition for event '" + eventName + "' in state node '" + this.id + "':\n" + err.message);
            }

            if (guardPassed && isInState) {
              if (candidate.target !== undefined) {
                nextStateNodes = candidate.target;
              }

              actions.push.apply(actions, __spread(candidate.actions));
              selectedTransition = candidate;
              break;
            }
          }
        } catch (e_3_1) {
          e_3 = {
            error: e_3_1
          };
        } finally {
          try {
            if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
          } finally {
            if (e_3) throw e_3.error;
          }
        }

        if (!selectedTransition) {
          return undefined;
        }

        if (!nextStateNodes.length) {
          return {
            transitions: [selectedTransition],
            entrySet: [],
            exitSet: [],
            configuration: state.value ? [this] : [],
            source: state,
            actions: actions
          };
        }

        var allNextStateNodes = flatten(nextStateNodes.map(function (stateNode) {
          return _this.getRelativeStateNodes(stateNode, state.historyValue);
        }));
        var isInternal = !!selectedTransition.internal;
        var reentryNodes = isInternal ? [] : flatten(allNextStateNodes.map(function (n) {
          return _this.nodesFromChild(n);
        }));
        return {
          transitions: [selectedTransition],
          entrySet: reentryNodes,
          exitSet: isInternal ? [] : [this],
          configuration: allNextStateNodes,
          source: state,
          actions: actions
        };
      };

      StateNode.prototype.nodesFromChild = function (childStateNode) {
        if (childStateNode.escapes(this)) {
          return [];
        }

        var nodes = [];
        var marker = childStateNode;

        while (marker && marker !== this) {
          nodes.push(marker);
          marker = marker.parent;
        }

        nodes.push(this); // inclusive

        return nodes;
      };
      /**
       * Whether the given state node "escapes" this state node. If the `stateNode` is equal to or the parent of
       * this state node, it does not escape.
       */


      StateNode.prototype.escapes = function (stateNode) {
        if (this === stateNode) {
          return false;
        }

        var parent = this.parent;

        while (parent) {
          if (parent === stateNode) {
            return false;
          }

          parent = parent.parent;
        }

        return true;
      };

      StateNode.prototype.evaluateGuard = function (guard, context, _event, state) {
        var guards = this.machine.options.guards;
        var guardMeta = {
          state: state,
          cond: guard,
          _event: _event
        }; // TODO: do not hardcode!

        if (guard.type === DEFAULT_GUARD_TYPE) {
          return guard.predicate(context, _event.data, guardMeta);
        }

        var condFn = guards[guard.type];

        if (!condFn) {
          throw new Error("Guard '" + guard.type + "' is not implemented on machine '" + this.machine.id + "'.");
        }

        return condFn(context, _event.data, guardMeta);
      };

      StateNode.prototype.getActions = function (transition, currentContext, _event, prevState) {
        var e_4, _a, e_5, _b;

        var prevConfig = getConfiguration([], prevState ? this.getStateNodes(prevState.value) : [this]);
        var resolvedConfig = transition.configuration.length ? getConfiguration(prevConfig, transition.configuration) : prevConfig;

        try {
          for (var resolvedConfig_1 = __values(resolvedConfig), resolvedConfig_1_1 = resolvedConfig_1.next(); !resolvedConfig_1_1.done; resolvedConfig_1_1 = resolvedConfig_1.next()) {
            var sn = resolvedConfig_1_1.value;

            if (!has(prevConfig, sn)) {
              transition.entrySet.push(sn);
            }
          }
        } catch (e_4_1) {
          e_4 = {
            error: e_4_1
          };
        } finally {
          try {
            if (resolvedConfig_1_1 && !resolvedConfig_1_1.done && (_a = resolvedConfig_1.return)) _a.call(resolvedConfig_1);
          } finally {
            if (e_4) throw e_4.error;
          }
        }

        try {
          for (var prevConfig_1 = __values(prevConfig), prevConfig_1_1 = prevConfig_1.next(); !prevConfig_1_1.done; prevConfig_1_1 = prevConfig_1.next()) {
            var sn = prevConfig_1_1.value;

            if (!has(resolvedConfig, sn) || has(transition.exitSet, sn.parent)) {
              transition.exitSet.push(sn);
            }
          }
        } catch (e_5_1) {
          e_5 = {
            error: e_5_1
          };
        } finally {
          try {
            if (prevConfig_1_1 && !prevConfig_1_1.done && (_b = prevConfig_1.return)) _b.call(prevConfig_1);
          } finally {
            if (e_5) throw e_5.error;
          }
        }

        if (!transition.source) {
          transition.exitSet = []; // Ensure that root StateNode (machine) is entered

          transition.entrySet.push(this);
        }

        var doneEvents = flatten(transition.entrySet.map(function (sn) {
          var events = [];

          if (sn.type !== 'final') {
            return events;
          }

          var parent = sn.parent;
          events.push(done(sn.id, sn.data), // TODO: deprecate - final states should not emit done events for their own state.
          done(parent.id, sn.data ? mapContext(sn.data, currentContext, _event) : undefined));

          if (parent.parent) {
            var grandparent = parent.parent;

            if (grandparent.type === 'parallel') {
              if (getChildren(grandparent).every(function (parentNode) {
                return isInFinalState(transition.configuration, parentNode);
              })) {
                events.push(done(grandparent.id, grandparent.data));
              }
            }
          }

          return events;
        }));
        transition.exitSet.sort(function (a, b) {
          return b.order - a.order;
        });
        transition.entrySet.sort(function (a, b) {
          return a.order - b.order;
        });
        var entryStates = new Set(transition.entrySet);
        var exitStates = new Set(transition.exitSet);

        var _c = __read([flatten(Array.from(entryStates).map(function (stateNode) {
          return __spread(stateNode.activities.map(function (activity) {
            return start$1(activity);
          }), stateNode.onEntry);
        })).concat(doneEvents.map(raise$1)), flatten(Array.from(exitStates).map(function (stateNode) {
          return __spread(stateNode.onExit, stateNode.activities.map(function (activity) {
            return stop$1(activity);
          }));
        }))], 2),
            entryActions = _c[0],
            exitActions = _c[1];

        var actions = toActionObjects(exitActions.concat(transition.actions).concat(entryActions), this.machine.options.actions);
        return actions;
      };
      /**
       * Determines the next state given the current `state` and sent `event`.
       *
       * @param state The current State instance or state value
       * @param event The event that was sent at the current state
       * @param context The current context (extended state) of the current state
       */


      StateNode.prototype.transition = function (state, event, context) {
        var _event = toSCXMLEvent(event);

        var currentState;

        if (state instanceof State) {
          currentState = context === undefined ? state : this.resolveState(State.from(state, context));
        } else {
          var resolvedStateValue = isString(state) ? this.resolve(pathToStateValue(this.getResolvedPath(state))) : this.resolve(state);
          var resolvedContext = context ? context : this.machine.context;
          currentState = this.resolveState(State.from(resolvedStateValue, resolvedContext));
        }

        if (this.strict) {
          if (this.events.indexOf(_event.name) === -1 && !isBuiltInEvent(_event.name)) {
            throw new Error("Machine '" + this.id + "' does not accept event '" + _event.name + "'");
          }
        }

        var stateTransition = this._transition(currentState.value, currentState, _event) || {
          transitions: [],
          configuration: [],
          entrySet: [],
          exitSet: [],
          source: currentState,
          actions: []
        };
        var prevConfig = getConfiguration([], this.getStateNodes(currentState.value));
        var resolvedConfig = stateTransition.configuration.length ? getConfiguration(prevConfig, stateTransition.configuration) : prevConfig;
        stateTransition.configuration = __spread(resolvedConfig);
        return this.resolveTransition(stateTransition, currentState, _event);
      };

      StateNode.prototype.resolveRaisedTransition = function (state, _event, originalEvent) {
        var _a;

        var currentActions = state.actions;
        state = this.transition(state, _event); // Save original event to state

        state._event = originalEvent;
        state.event = originalEvent.data;

        (_a = state.actions).unshift.apply(_a, __spread(currentActions));

        return state;
      };

      StateNode.prototype.resolveTransition = function (stateTransition, currentState, _event, context) {
        var e_6, _a;

        var _this = this;

        if (_event === void 0) {
          _event = initEvent;
        }

        if (context === void 0) {
          context = this.machine.context;
        }

        var configuration = stateTransition.configuration; // Transition will "apply" if:
        // - this is the initial state (there is no current state)
        // - OR there are transitions

        var willTransition = !currentState || stateTransition.transitions.length > 0;
        var resolvedStateValue = willTransition ? getValue(this.machine, configuration) : undefined;
        var historyValue = currentState ? currentState.historyValue ? currentState.historyValue : stateTransition.source ? this.machine.historyValue(currentState.value) : undefined : undefined;
        var currentContext = currentState ? currentState.context : context;
        var actions = this.getActions(stateTransition, currentContext, _event, currentState);
        var activities = currentState ? __assign({}, currentState.activities) : {};

        try {
          for (var actions_1 = __values(actions), actions_1_1 = actions_1.next(); !actions_1_1.done; actions_1_1 = actions_1.next()) {
            var action = actions_1_1.value;

            if (action.type === start) {
              activities[action.activity.type] = action;
            } else if (action.type === stop) {
              activities[action.activity.type] = false;
            }
          }
        } catch (e_6_1) {
          e_6 = {
            error: e_6_1
          };
        } finally {
          try {
            if (actions_1_1 && !actions_1_1.done && (_a = actions_1.return)) _a.call(actions_1);
          } finally {
            if (e_6) throw e_6.error;
          }
        }

        var _b = __read(partition(actions, function (action) {
          return action.type === assign$1;
        }), 2),
            assignActions = _b[0],
            otherActions = _b[1];

        var updatedContext = assignActions.length ? updateContext(currentContext, _event, assignActions, currentState) : currentContext;
        var resolvedActions = flatten(otherActions.map(function (actionObject) {
          switch (actionObject.type) {
            case raise:
              return resolveRaise(actionObject);

            case send:
              var sendAction = resolveSend(actionObject, updatedContext, _event, _this.machine.options.delays); // TODO: fix ActionTypes.Init

              return sendAction;

            case log:
              return resolveLog(actionObject, updatedContext, _event);

            case ActionTypes.Pure:
              return actionObject.get(updatedContext, _event.data) || [];

            default:
              return toActionObject(actionObject, _this.options.actions);
          }
        }));

        var _c = __read(partition(resolvedActions, function (action) {
          return action.type === raise || action.type === send && action.to === SpecialTargets.Internal;
        }), 2),
            raisedEvents = _c[0],
            nonRaisedActions = _c[1];

        var invokeActions = resolvedActions.filter(function (action) {
          return action.type === start && action.activity.type === invoke;
        });
        var children = invokeActions.reduce(function (acc, action) {
          acc[action.activity.id] = createInvocableActor(action.activity);
          return acc;
        }, currentState ? __assign({}, currentState.children) : {});
        var stateNodes = resolvedStateValue ? this.getStateNodes(resolvedStateValue) : [];

        var meta = __spread([this], stateNodes).reduce(function (acc, stateNode) {
          if (stateNode.meta !== undefined) {
            acc[stateNode.id] = stateNode.meta;
          }

          return acc;
        }, {});

        var nextState = new State({
          value: resolvedStateValue || currentState.value,
          context: updatedContext,
          _event: _event,
          historyValue: resolvedStateValue ? historyValue ? updateHistoryValue(historyValue, resolvedStateValue) : undefined : currentState ? currentState.historyValue : undefined,
          history: !resolvedStateValue || stateTransition.source ? currentState : undefined,
          actions: resolvedStateValue ? nonRaisedActions : [],
          activities: resolvedStateValue ? activities : currentState ? currentState.activities : {},
          meta: resolvedStateValue ? meta : currentState ? currentState.meta : undefined,
          events: [],
          configuration: resolvedStateValue ? stateTransition.configuration : currentState ? currentState.configuration : [],
          transitions: stateTransition.transitions,
          children: children
        });
        nextState.changed = _event.name === update$1 || !!assignActions.length; // Dispose of penultimate histories to prevent memory leaks

        var history = nextState.history;

        if (history) {
          delete history.history;
        }

        if (!resolvedStateValue) {
          return nextState;
        }

        var maybeNextState = nextState;
        var isTransient = stateNodes.some(function (stateNode) {
          return stateNode._transient;
        });

        if (isTransient) {
          maybeNextState = this.resolveRaisedTransition(maybeNextState, {
            type: nullEvent
          }, _event);
        }

        while (raisedEvents.length) {
          var raisedEvent = raisedEvents.shift();
          maybeNextState = this.resolveRaisedTransition(maybeNextState, raisedEvent._event, _event);
        } // Detect if state changed


        var changed = maybeNextState.changed || (history ? !!maybeNextState.actions.length || !!assignActions.length || typeof history.value !== typeof maybeNextState.value || !stateValuesEqual(maybeNextState.value, history.value) : undefined);
        maybeNextState.changed = changed; // Preserve original history after raised events

        maybeNextState.historyValue = nextState.historyValue;
        maybeNextState.history = history;
        return maybeNextState;
      };
      /**
       * Returns the child state node from its relative `stateKey`, or throws.
       */


      StateNode.prototype.getStateNode = function (stateKey) {
        if (isStateId(stateKey)) {
          return this.machine.getStateNodeById(stateKey);
        }

        if (!this.states) {
          throw new Error("Unable to retrieve child state '" + stateKey + "' from '" + this.id + "'; no child states exist.");
        }

        var result = this.states[stateKey];

        if (!result) {
          throw new Error("Child state '" + stateKey + "' does not exist on '" + this.id + "'");
        }

        return result;
      };
      /**
       * Returns the state node with the given `stateId`, or throws.
       *
       * @param stateId The state ID. The prefix "#" is removed.
       */


      StateNode.prototype.getStateNodeById = function (stateId) {
        var resolvedStateId = isStateId(stateId) ? stateId.slice(STATE_IDENTIFIER.length) : stateId;

        if (resolvedStateId === this.id) {
          return this;
        }

        var stateNode = this.machine.idMap[resolvedStateId];

        if (!stateNode) {
          throw new Error("Child state node '#" + resolvedStateId + "' does not exist on machine '" + this.id + "'");
        }

        return stateNode;
      };
      /**
       * Returns the relative state node from the given `statePath`, or throws.
       *
       * @param statePath The string or string array relative path to the state node.
       */


      StateNode.prototype.getStateNodeByPath = function (statePath) {
        if (typeof statePath === 'string' && isStateId(statePath)) {
          try {
            return this.getStateNodeById(statePath.slice(1));
          } catch (e) {// try individual paths
            // throw e;
          }
        }

        var arrayStatePath = toStatePath(statePath, this.delimiter).slice();
        var currentStateNode = this;

        while (arrayStatePath.length) {
          var key = arrayStatePath.shift();

          if (!key.length) {
            break;
          }

          currentStateNode = currentStateNode.getStateNode(key);
        }

        return currentStateNode;
      };
      /**
       * Resolves a partial state value with its full representation in this machine.
       *
       * @param stateValue The partial state value to resolve.
       */


      StateNode.prototype.resolve = function (stateValue) {
        var _a;

        var _this = this;

        if (!stateValue) {
          return this.initialStateValue || EMPTY_OBJECT; // TODO: type-specific properties
        }

        switch (this.type) {
          case 'parallel':
            return mapValues(this.initialStateValue, function (subStateValue, subStateKey) {
              return subStateValue ? _this.getStateNode(subStateKey).resolve(stateValue[subStateKey] || subStateValue) : EMPTY_OBJECT;
            });

          case 'compound':
            if (isString(stateValue)) {
              var subStateNode = this.getStateNode(stateValue);

              if (subStateNode.type === 'parallel' || subStateNode.type === 'compound') {
                return _a = {}, _a[stateValue] = subStateNode.initialStateValue, _a;
              }

              return stateValue;
            }

            if (!keys(stateValue).length) {
              return this.initialStateValue || {};
            }

            return mapValues(stateValue, function (subStateValue, subStateKey) {
              return subStateValue ? _this.getStateNode(subStateKey).resolve(subStateValue) : EMPTY_OBJECT;
            });

          default:
            return stateValue || EMPTY_OBJECT;
        }
      };

      StateNode.prototype.getResolvedPath = function (stateIdentifier) {
        if (isStateId(stateIdentifier)) {
          var stateNode = this.machine.idMap[stateIdentifier.slice(STATE_IDENTIFIER.length)];

          if (!stateNode) {
            throw new Error("Unable to find state node '" + stateIdentifier + "'");
          }

          return stateNode.path;
        }

        return toStatePath(stateIdentifier, this.delimiter);
      };

      Object.defineProperty(StateNode.prototype, "initialStateValue", {
        get: function () {
          var _a;

          if (this.__cache.initialStateValue) {
            return this.__cache.initialStateValue;
          }

          var initialStateValue;

          if (this.type === 'parallel') {
            initialStateValue = mapFilterValues(this.states, function (state) {
              return state.initialStateValue || EMPTY_OBJECT;
            }, function (stateNode) {
              return !(stateNode.type === 'history');
            });
          } else if (this.initial !== undefined) {
            if (!this.states[this.initial]) {
              throw new Error("Initial state '" + this.initial + "' not found on '" + this.key + "'");
            }

            initialStateValue = isLeafNode(this.states[this.initial]) ? this.initial : (_a = {}, _a[this.initial] = this.states[this.initial].initialStateValue, _a);
          }

          this.__cache.initialStateValue = initialStateValue;
          return this.__cache.initialStateValue;
        },
        enumerable: true,
        configurable: true
      });

      StateNode.prototype.getInitialState = function (stateValue, context) {
        var configuration = this.getStateNodes(stateValue);
        return this.resolveTransition({
          configuration: configuration,
          entrySet: configuration,
          exitSet: [],
          transitions: [],
          source: undefined,
          actions: []
        }, undefined, undefined, context);
      };

      Object.defineProperty(StateNode.prototype, "initialState", {
        /**
         * The initial State instance, which includes all actions to be executed from
         * entering the initial state.
         */
        get: function () {
          this._init();

          var initialStateValue = this.initialStateValue;

          if (!initialStateValue) {
            throw new Error("Cannot retrieve initial state from simple state '" + this.id + "'.");
          }

          return this.getInitialState(initialStateValue);
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(StateNode.prototype, "target", {
        /**
         * The target state value of the history state node, if it exists. This represents the
         * default state value to transition to if no history value exists yet.
         */
        get: function () {
          var target;

          if (this.type === 'history') {
            var historyConfig = this.config;

            if (isString(historyConfig.target)) {
              target = isStateId(historyConfig.target) ? pathToStateValue(this.machine.getStateNodeById(historyConfig.target).path.slice(this.path.length - 1)) : historyConfig.target;
            } else {
              target = historyConfig.target;
            }
          }

          return target;
        },
        enumerable: true,
        configurable: true
      });

      StateNode.prototype.getStates = function (stateValue) {
        var e_7, _a;

        if (isString(stateValue)) {
          return [this.states[stateValue]];
        }

        var stateNodes = [];

        try {
          for (var _b = __values(keys(stateValue)), _c = _b.next(); !_c.done; _c = _b.next()) {
            var key = _c.value;
            stateNodes.push.apply(stateNodes, __spread(this.states[key].getStates(stateValue[key])));
          }
        } catch (e_7_1) {
          e_7 = {
            error: e_7_1
          };
        } finally {
          try {
            if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
          } finally {
            if (e_7) throw e_7.error;
          }
        }

        return stateNodes;
      };
      /**
       * Returns the leaf nodes from a state path relative to this state node.
       *
       * @param relativeStateId The relative state path to retrieve the state nodes
       * @param history The previous state to retrieve history
       * @param resolve Whether state nodes should resolve to initial child state nodes
       */


      StateNode.prototype.getRelativeStateNodes = function (relativeStateId, historyValue, resolve) {
        if (resolve === void 0) {
          resolve = true;
        }

        return resolve ? relativeStateId.type === 'history' ? relativeStateId.resolveHistory(historyValue) : relativeStateId.initialStateNodes : [relativeStateId];
      };

      Object.defineProperty(StateNode.prototype, "initialStateNodes", {
        get: function () {
          var _this = this;

          if (isLeafNode(this)) {
            return [this];
          } // Case when state node is compound but no initial state is defined


          if (this.type === 'compound' && !this.initial) {

            return [this];
          }

          var initialStateNodePaths = toStatePaths(this.initialStateValue);
          return flatten(initialStateNodePaths.map(function (initialPath) {
            return _this.getFromRelativePath(initialPath);
          }));
        },
        enumerable: true,
        configurable: true
      });
      /**
       * Retrieves state nodes from a relative path to this state node.
       *
       * @param relativePath The relative path from this state node
       * @param historyValue
       */

      StateNode.prototype.getFromRelativePath = function (relativePath) {
        if (!relativePath.length) {
          return [this];
        }

        var _a = __read(relativePath),
            stateKey = _a[0],
            childStatePath = _a.slice(1);

        if (!this.states) {
          throw new Error("Cannot retrieve subPath '" + stateKey + "' from node with no states");
        }

        var childStateNode = this.getStateNode(stateKey);

        if (childStateNode.type === 'history') {
          return childStateNode.resolveHistory();
        }

        if (!this.states[stateKey]) {
          throw new Error("Child state '" + stateKey + "' does not exist on '" + this.id + "'");
        }

        return this.states[stateKey].getFromRelativePath(childStatePath);
      };

      StateNode.prototype.historyValue = function (relativeStateValue) {
        if (!keys(this.states).length) {
          return undefined;
        }

        return {
          current: relativeStateValue || this.initialStateValue,
          states: mapFilterValues(this.states, function (stateNode, key) {
            if (!relativeStateValue) {
              return stateNode.historyValue();
            }

            var subStateValue = isString(relativeStateValue) ? undefined : relativeStateValue[key];
            return stateNode.historyValue(subStateValue || stateNode.initialStateValue);
          }, function (stateNode) {
            return !stateNode.history;
          })
        };
      };
      /**
       * Resolves to the historical value(s) of the parent state node,
       * represented by state nodes.
       *
       * @param historyValue
       */


      StateNode.prototype.resolveHistory = function (historyValue) {
        var _this = this;

        if (this.type !== 'history') {
          return [this];
        }

        var parent = this.parent;

        if (!historyValue) {
          var historyTarget = this.target;
          return historyTarget ? flatten(toStatePaths(historyTarget).map(function (relativeChildPath) {
            return parent.getFromRelativePath(relativeChildPath);
          })) : parent.initialStateNodes;
        }

        var subHistoryValue = nestedPath(parent.path, 'states')(historyValue).current;

        if (isString(subHistoryValue)) {
          return [parent.getStateNode(subHistoryValue)];
        }

        return flatten(toStatePaths(subHistoryValue).map(function (subStatePath) {
          return _this.history === 'deep' ? parent.getFromRelativePath(subStatePath) : [parent.states[subStatePath[0]]];
        }));
      };

      Object.defineProperty(StateNode.prototype, "stateIds", {
        /**
         * All the state node IDs of this state node and its descendant state nodes.
         */
        get: function () {
          var _this = this;

          var childStateIds = flatten(keys(this.states).map(function (stateKey) {
            return _this.states[stateKey].stateIds;
          }));
          return [this.id].concat(childStateIds);
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(StateNode.prototype, "events", {
        /**
         * All the event types accepted by this state node and its descendants.
         */
        get: function () {
          var e_8, _a, e_9, _b;

          if (this.__cache.events) {
            return this.__cache.events;
          }

          var states = this.states;
          var events = new Set(this.ownEvents);

          if (states) {
            try {
              for (var _c = __values(keys(states)), _d = _c.next(); !_d.done; _d = _c.next()) {
                var stateId = _d.value;
                var state = states[stateId];

                if (state.states) {
                  try {
                    for (var _e = (e_9 = void 0, __values(state.events)), _f = _e.next(); !_f.done; _f = _e.next()) {
                      var event_1 = _f.value;
                      events.add("" + event_1);
                    }
                  } catch (e_9_1) {
                    e_9 = {
                      error: e_9_1
                    };
                  } finally {
                    try {
                      if (_f && !_f.done && (_b = _e.return)) _b.call(_e);
                    } finally {
                      if (e_9) throw e_9.error;
                    }
                  }
                }
              }
            } catch (e_8_1) {
              e_8 = {
                error: e_8_1
              };
            } finally {
              try {
                if (_d && !_d.done && (_a = _c.return)) _a.call(_c);
              } finally {
                if (e_8) throw e_8.error;
              }
            }
          }

          return this.__cache.events = Array.from(events);
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(StateNode.prototype, "ownEvents", {
        /**
         * All the events that have transitions directly from this state node.
         *
         * Excludes any inert events.
         */
        get: function () {
          var events = new Set(this.transitions.filter(function (transition) {
            return !(!transition.target && !transition.actions.length && transition.internal);
          }).map(function (transition) {
            return transition.eventType;
          }));
          return Array.from(events);
        },
        enumerable: true,
        configurable: true
      });

      StateNode.prototype.resolveTarget = function (_target) {
        var _this = this;

        if (_target === undefined) {
          // an undefined target signals that the state node should not transition from that state when receiving that event
          return undefined;
        }

        return _target.map(function (target) {
          if (!isString(target)) {
            return target;
          }

          var isInternalTarget = target[0] === _this.delimiter; // If internal target is defined on machine,
          // do not include machine key on target

          if (isInternalTarget && !_this.parent) {
            return _this.getStateNodeByPath(target.slice(1));
          }

          var resolvedTarget = isInternalTarget ? _this.key + target : target;

          if (_this.parent) {
            try {
              var targetStateNode = _this.parent.getStateNodeByPath(resolvedTarget);

              return targetStateNode;
            } catch (err) {
              throw new Error("Invalid transition definition for state node '" + _this.id + "':\n" + err.message);
            }
          } else {
            return _this.getStateNodeByPath(resolvedTarget);
          }
        });
      };

      StateNode.prototype.formatTransition = function (transitionConfig) {
        var _this = this;

        var normalizedTarget = normalizeTarget(transitionConfig.target);
        var internal = 'internal' in transitionConfig ? transitionConfig.internal : normalizedTarget ? normalizedTarget.some(function (target) {
          return isString(target) && target[0] === _this.delimiter;
        }) : true;
        var guards = this.machine.options.guards;
        var target = this.resolveTarget(normalizedTarget);
        return __assign(__assign({}, transitionConfig), {
          actions: toActionObjects(toArray(transitionConfig.actions)),
          cond: toGuard(transitionConfig.cond, guards),
          target: target,
          source: this,
          internal: internal,
          eventType: transitionConfig.event
        });
      };

      StateNode.prototype.formatTransitions = function () {
        var e_10, _a;

        var _this = this;

        var onConfig;

        if (!this.config.on) {
          onConfig = [];
        } else if (Array.isArray(this.config.on)) {
          onConfig = this.config.on;
        } else {
          var _b = this.config.on,
              _c = WILDCARD,
              _d = _b[_c],
              wildcardConfigs = _d === void 0 ? [] : _d,
              strictOnConfigs_1 = __rest(_b, [typeof _c === "symbol" ? _c : _c + ""]);

          onConfig = flatten(keys(strictOnConfigs_1).map(function (key) {
            var arrayified = toTransitionConfigArray(key, strictOnConfigs_1[key]);

            return arrayified;
          }).concat(toTransitionConfigArray(WILDCARD, wildcardConfigs)));
        }

        var doneConfig = this.config.onDone ? toTransitionConfigArray(String(done(this.id)), this.config.onDone) : [];
        var invokeConfig = flatten(this.invoke.map(function (invokeDef) {
          var settleTransitions = [];

          if (invokeDef.onDone) {
            settleTransitions.push.apply(settleTransitions, __spread(toTransitionConfigArray(String(doneInvoke(invokeDef.id)), invokeDef.onDone)));
          }

          if (invokeDef.onError) {
            settleTransitions.push.apply(settleTransitions, __spread(toTransitionConfigArray(String(error(invokeDef.id)), invokeDef.onError)));
          }

          return settleTransitions;
        }));
        var delayedTransitions = this.after;
        var formattedTransitions = flatten(__spread(doneConfig, invokeConfig, onConfig).map(function (transitionConfig) {
          return toArray(transitionConfig).map(function (transition) {
            return _this.formatTransition(transition);
          });
        }));

        try {
          for (var delayedTransitions_1 = __values(delayedTransitions), delayedTransitions_1_1 = delayedTransitions_1.next(); !delayedTransitions_1_1.done; delayedTransitions_1_1 = delayedTransitions_1.next()) {
            var delayedTransition = delayedTransitions_1_1.value;
            formattedTransitions.push(delayedTransition);
          }
        } catch (e_10_1) {
          e_10 = {
            error: e_10_1
          };
        } finally {
          try {
            if (delayedTransitions_1_1 && !delayedTransitions_1_1.done && (_a = delayedTransitions_1.return)) _a.call(delayedTransitions_1);
          } finally {
            if (e_10) throw e_10.error;
          }
        }

        return formattedTransitions;
      };

      return StateNode;
    }();

    function Machine(config, options, initialContext) {
      if (initialContext === void 0) {
        initialContext = config.context;
      }

      var resolvedInitialContext = typeof initialContext === 'function' ? initialContext() : initialContext;
      return new StateNode(config, options, resolvedInitialContext);
    }

    var defaultOptions = {
      deferEvents: false
    };

    var Scheduler =
    /*#__PURE__*/

    /** @class */
    function () {
      function Scheduler(options) {
        this.processingEvent = false;
        this.queue = [];
        this.initialized = false;
        this.options = __assign(__assign({}, defaultOptions), options);
      }

      Scheduler.prototype.initialize = function (callback) {
        this.initialized = true;

        if (callback) {
          if (!this.options.deferEvents) {
            this.schedule(callback);
            return;
          }

          this.process(callback);
        }

        this.flushEvents();
      };

      Scheduler.prototype.schedule = function (task) {
        if (!this.initialized || this.processingEvent) {
          this.queue.push(task);
          return;
        }

        if (this.queue.length !== 0) {
          throw new Error('Event queue should be empty when it is not processing events');
        }

        this.process(task);
        this.flushEvents();
      };

      Scheduler.prototype.clear = function () {
        this.queue = [];
      };

      Scheduler.prototype.flushEvents = function () {
        var nextCallback = this.queue.shift();

        while (nextCallback) {
          this.process(nextCallback);
          nextCallback = this.queue.shift();
        }
      };

      Scheduler.prototype.process = function (callback) {
        this.processingEvent = true;

        try {
          callback();
        } catch (e) {
          // there is no use to keep the future events
          // as the situation is not anymore the same
          this.clear();
          throw e;
        } finally {
          this.processingEvent = false;
        }
      };

      return Scheduler;
    }();

    var DEFAULT_SPAWN_OPTIONS = {
      sync: false,
      autoForward: false
    };
    /**
     * Maintains a stack of the current service in scope.
     * This is used to provide the correct service to spawn().
     *
     * @private
     */

    var withServiceScope =
    /*#__PURE__*/
    function () {
      var serviceStack = [];
      return function (service, fn) {
        service && serviceStack.push(service);
        var result = fn(service || serviceStack[serviceStack.length - 1]);
        service && serviceStack.pop();
        return result;
      };
    }();

    var InterpreterStatus;

    (function (InterpreterStatus) {
      InterpreterStatus[InterpreterStatus["NotStarted"] = 0] = "NotStarted";
      InterpreterStatus[InterpreterStatus["Running"] = 1] = "Running";
      InterpreterStatus[InterpreterStatus["Stopped"] = 2] = "Stopped";
    })(InterpreterStatus || (InterpreterStatus = {}));

    var Interpreter =
    /*#__PURE__*/

    /** @class */
    function () {
      /**
       * Creates a new Interpreter instance (i.e., service) for the given machine with the provided options, if any.
       *
       * @param machine The machine to be interpreted
       * @param options Interpreter options
       */
      function Interpreter(machine, options) {
        var _this = this;

        if (options === void 0) {
          options = Interpreter.defaultOptions;
        }

        this.machine = machine;
        this.scheduler = new Scheduler();
        this.delayedEventsMap = {};
        this.listeners = new Set();
        this.contextListeners = new Set();
        this.stopListeners = new Set();
        this.doneListeners = new Set();
        this.eventListeners = new Set();
        this.sendListeners = new Set();
        /**
         * Whether the service is started.
         */

        this.initialized = false;
        this._status = InterpreterStatus.NotStarted;
        this.children = new Map();
        this.forwardTo = new Set();
        /**
         * Alias for Interpreter.prototype.start
         */

        this.init = this.start;
        /**
         * Sends an event to the running interpreter to trigger a transition.
         *
         * An array of events (batched) can be sent as well, which will send all
         * batched events to the running interpreter. The listeners will be
         * notified only **once** when all events are processed.
         *
         * @param event The event(s) to send
         */

        this.send = function (event, payload) {
          if (_this._status === InterpreterStatus.Stopped) {
            // do nothing
            return _this.state;
          }

          if (isArray(event)) {
            _this.batch(event);

            return _this.state;
          }

          var _event = toSCXMLEvent(toEventObject(event, payload));

          if (_this._status === InterpreterStatus.NotStarted && _this.options.deferEvents) ; else if (_this._status !== InterpreterStatus.Running) {
            throw new Error("Event \"" + _event.name + "\" was sent to uninitialized service \"" + _this.machine.id + "\". Make sure .start() is called for this service, or set { deferEvents: true } in the service options.\nEvent: " + JSON.stringify(_event.data));
          }

          _this.scheduler.schedule(function () {
            // Forward copy of event to child actors
            _this.forward(_event);

            var nextState = _this.nextState(_event);

            _this.update(nextState, _event);
          });

          return _this._state; // TODO: deprecate (should return void)
          // tslint:disable-next-line:semicolon
        };

        this.sendTo = function (event, to) {
          var isParent = _this.parent && (to === SpecialTargets.Parent || _this.parent.id === to);
          var target = isParent ? _this.parent : isActor(to) ? to : _this.children.get(to);

          if (!target) {
            if (!isParent) {
              throw new Error("Unable to send event to child '" + to + "' from service '" + _this.id + "'.");
            } // tslint:disable-next-line:no-console

            return;
          }

          if ('machine' in target) {
            // Send SCXML events to machines
            target.send(__assign(__assign({}, event), {
              origin: _this.id
            }));
          } else {
            // Send normal events to other targets
            target.send(event.data);
          }
        };

        var resolvedOptions = __assign(__assign({}, Interpreter.defaultOptions), options);

        var clock = resolvedOptions.clock,
            logger = resolvedOptions.logger,
            parent = resolvedOptions.parent,
            id = resolvedOptions.id;
        var resolvedId = id !== undefined ? id : machine.id;
        this.id = resolvedId;
        this.logger = logger;
        this.clock = clock;
        this.parent = parent;
        this.options = resolvedOptions;
        this.scheduler = new Scheduler({
          deferEvents: this.options.deferEvents
        });
      }

      Object.defineProperty(Interpreter.prototype, "initialState", {
        get: function () {
          return this.machine.initialState;
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(Interpreter.prototype, "state", {
        get: function () {

          return this._state;
        },
        enumerable: true,
        configurable: true
      });
      /**
       * Executes the actions of the given state, with that state's `context` and `event`.
       *
       * @param state The state whose actions will be executed
       * @param actionsConfig The action implementations to use
       */

      Interpreter.prototype.execute = function (state, actionsConfig) {
        var e_1, _a;

        try {
          for (var _b = __values(state.actions), _c = _b.next(); !_c.done; _c = _b.next()) {
            var action = _c.value;
            this.exec(action, state, actionsConfig);
          }
        } catch (e_1_1) {
          e_1 = {
            error: e_1_1
          };
        } finally {
          try {
            if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
          } finally {
            if (e_1) throw e_1.error;
          }
        }
      };

      Interpreter.prototype.update = function (state, _event) {
        var e_2, _a, e_3, _b, e_4, _c, e_5, _d;

        var _this = this; // Update state


        this._state = state; // Execute actions

        if (this.options.execute) {
          this.execute(this.state);
        } // Dev tools


        if (this.devTools) {
          this.devTools.send(_event.data, state);
        } // Execute listeners


        if (state.event) {
          try {
            for (var _e = __values(this.eventListeners), _f = _e.next(); !_f.done; _f = _e.next()) {
              var listener = _f.value;
              listener(state.event);
            }
          } catch (e_2_1) {
            e_2 = {
              error: e_2_1
            };
          } finally {
            try {
              if (_f && !_f.done && (_a = _e.return)) _a.call(_e);
            } finally {
              if (e_2) throw e_2.error;
            }
          }
        }

        try {
          for (var _g = __values(this.listeners), _h = _g.next(); !_h.done; _h = _g.next()) {
            var listener = _h.value;
            listener(state, state.event);
          }
        } catch (e_3_1) {
          e_3 = {
            error: e_3_1
          };
        } finally {
          try {
            if (_h && !_h.done && (_b = _g.return)) _b.call(_g);
          } finally {
            if (e_3) throw e_3.error;
          }
        }

        try {
          for (var _j = __values(this.contextListeners), _k = _j.next(); !_k.done; _k = _j.next()) {
            var contextListener = _k.value;
            contextListener(this.state.context, this.state.history ? this.state.history.context : undefined);
          }
        } catch (e_4_1) {
          e_4 = {
            error: e_4_1
          };
        } finally {
          try {
            if (_k && !_k.done && (_c = _j.return)) _c.call(_j);
          } finally {
            if (e_4) throw e_4.error;
          }
        }

        var isDone = isInFinalState(state.configuration || [], this.machine);

        if (this.state.configuration && isDone) {
          // get final child state node
          var finalChildStateNode = state.configuration.find(function (sn) {
            return sn.type === 'final' && sn.parent === _this.machine;
          });
          var doneData = finalChildStateNode && finalChildStateNode.data ? mapContext(finalChildStateNode.data, state.context, _event) : undefined;

          try {
            for (var _l = __values(this.doneListeners), _m = _l.next(); !_m.done; _m = _l.next()) {
              var listener = _m.value;
              listener(doneInvoke(this.id, doneData));
            }
          } catch (e_5_1) {
            e_5 = {
              error: e_5_1
            };
          } finally {
            try {
              if (_m && !_m.done && (_d = _l.return)) _d.call(_l);
            } finally {
              if (e_5) throw e_5.error;
            }
          }

          this.stop();
        }
      };
      /*
       * Adds a listener that is notified whenever a state transition happens. The listener is called with
       * the next state and the event object that caused the state transition.
       *
       * @param listener The state listener
       */


      Interpreter.prototype.onTransition = function (listener) {
        this.listeners.add(listener);
        return this;
      };

      Interpreter.prototype.subscribe = function (nextListener, // @ts-ignore
      errorListener, completeListener) {
        var _this = this;

        if (nextListener) {
          this.onTransition(nextListener);
        }

        if (completeListener) {
          this.onDone(completeListener);
        }

        return {
          unsubscribe: function () {
            nextListener && _this.listeners.delete(nextListener);
            completeListener && _this.doneListeners.delete(completeListener);
          }
        };
      };
      /**
       * Adds an event listener that is notified whenever an event is sent to the running interpreter.
       * @param listener The event listener
       */


      Interpreter.prototype.onEvent = function (listener) {
        this.eventListeners.add(listener);
        return this;
      };
      /**
       * Adds an event listener that is notified whenever a `send` event occurs.
       * @param listener The event listener
       */


      Interpreter.prototype.onSend = function (listener) {
        this.sendListeners.add(listener);
        return this;
      };
      /**
       * Adds a context listener that is notified whenever the state context changes.
       * @param listener The context listener
       */


      Interpreter.prototype.onChange = function (listener) {
        this.contextListeners.add(listener);
        return this;
      };
      /**
       * Adds a listener that is notified when the machine is stopped.
       * @param listener The listener
       */


      Interpreter.prototype.onStop = function (listener) {
        this.stopListeners.add(listener);
        return this;
      };
      /**
       * Adds a state listener that is notified when the statechart has reached its final state.
       * @param listener The state listener
       */


      Interpreter.prototype.onDone = function (listener) {
        this.doneListeners.add(listener);
        return this;
      };
      /**
       * Removes a listener.
       * @param listener The listener to remove
       */


      Interpreter.prototype.off = function (listener) {
        this.listeners.delete(listener);
        this.eventListeners.delete(listener);
        this.sendListeners.delete(listener);
        this.stopListeners.delete(listener);
        this.doneListeners.delete(listener);
        this.contextListeners.delete(listener);
        return this;
      };
      /**
       * Starts the interpreter from the given state, or the initial state.
       * @param initialState The state to start the statechart from
       */


      Interpreter.prototype.start = function (initialState) {
        var _this = this;

        if (this._status === InterpreterStatus.Running) {
          // Do not restart the service if it is already started
          return this;
        }

        this.initialized = true;
        this._status = InterpreterStatus.Running;
        var resolvedState = withServiceScope(this, function () {
          return initialState === undefined ? _this.machine.initialState : isState(initialState) ? _this.machine.resolveState(initialState) : _this.machine.resolveState(State.from(initialState, _this.machine.context));
        });

        if (this.options.devTools) {
          this.attachDev();
        }

        this.scheduler.initialize(function () {
          _this.update(resolvedState, initEvent);
        });
        return this;
      };
      /**
       * Stops the interpreter and unsubscribe all listeners.
       *
       * This will also notify the `onStop` listeners.
       */


      Interpreter.prototype.stop = function () {
        var e_6, _a, e_7, _b, e_8, _c, e_9, _d, e_10, _e;

        try {
          for (var _f = __values(this.listeners), _g = _f.next(); !_g.done; _g = _f.next()) {
            var listener = _g.value;
            this.listeners.delete(listener);
          }
        } catch (e_6_1) {
          e_6 = {
            error: e_6_1
          };
        } finally {
          try {
            if (_g && !_g.done && (_a = _f.return)) _a.call(_f);
          } finally {
            if (e_6) throw e_6.error;
          }
        }

        try {
          for (var _h = __values(this.stopListeners), _j = _h.next(); !_j.done; _j = _h.next()) {
            var listener = _j.value; // call listener, then remove

            listener();
            this.stopListeners.delete(listener);
          }
        } catch (e_7_1) {
          e_7 = {
            error: e_7_1
          };
        } finally {
          try {
            if (_j && !_j.done && (_b = _h.return)) _b.call(_h);
          } finally {
            if (e_7) throw e_7.error;
          }
        }

        try {
          for (var _k = __values(this.contextListeners), _l = _k.next(); !_l.done; _l = _k.next()) {
            var listener = _l.value;
            this.contextListeners.delete(listener);
          }
        } catch (e_8_1) {
          e_8 = {
            error: e_8_1
          };
        } finally {
          try {
            if (_l && !_l.done && (_c = _k.return)) _c.call(_k);
          } finally {
            if (e_8) throw e_8.error;
          }
        }

        try {
          for (var _m = __values(this.doneListeners), _o = _m.next(); !_o.done; _o = _m.next()) {
            var listener = _o.value;
            this.doneListeners.delete(listener);
          }
        } catch (e_9_1) {
          e_9 = {
            error: e_9_1
          };
        } finally {
          try {
            if (_o && !_o.done && (_d = _m.return)) _d.call(_m);
          } finally {
            if (e_9) throw e_9.error;
          }
        } // Stop all children


        this.children.forEach(function (child) {
          if (isFunction(child.stop)) {
            child.stop();
          }
        });

        try {
          // Cancel all delayed events
          for (var _p = __values(keys(this.delayedEventsMap)), _q = _p.next(); !_q.done; _q = _p.next()) {
            var key = _q.value;
            this.clock.clearTimeout(this.delayedEventsMap[key]);
          }
        } catch (e_10_1) {
          e_10 = {
            error: e_10_1
          };
        } finally {
          try {
            if (_q && !_q.done && (_e = _p.return)) _e.call(_p);
          } finally {
            if (e_10) throw e_10.error;
          }
        }

        this.scheduler.clear();
        this.initialized = false;
        this._status = InterpreterStatus.Stopped;
        return this;
      };

      Interpreter.prototype.batch = function (events) {
        var _this = this;

        if (this._status === InterpreterStatus.NotStarted && this.options.deferEvents) ; else if (this._status !== InterpreterStatus.Running) {
          throw new Error( // tslint:disable-next-line:max-line-length
          events.length + " event(s) were sent to uninitialized service \"" + this.machine.id + "\". Make sure .start() is called for this service, or set { deferEvents: true } in the service options.");
        }

        this.scheduler.schedule(function () {
          var e_11, _a, _b;

          var nextState = _this.state;

          try {
            for (var events_1 = __values(events), events_1_1 = events_1.next(); !events_1_1.done; events_1_1 = events_1.next()) {
              var event_1 = events_1_1.value;
              var changed = nextState.changed;

              var _event = toSCXMLEvent(event_1);

              var actions = nextState.actions.map(function (a) {
                return bindActionToState(a, nextState);
              });
              nextState = _this.machine.transition(nextState, _event);

              (_b = nextState.actions).unshift.apply(_b, __spread(actions));

              nextState.changed = nextState.changed || !!changed;

              _this.forward(_event);
            }
          } catch (e_11_1) {
            e_11 = {
              error: e_11_1
            };
          } finally {
            try {
              if (events_1_1 && !events_1_1.done && (_a = events_1.return)) _a.call(events_1);
            } finally {
              if (e_11) throw e_11.error;
            }
          }

          _this.update(nextState, toSCXMLEvent(events[events.length - 1]));
        });
      };
      /**
       * Returns a send function bound to this interpreter instance.
       *
       * @param event The event to be sent by the sender.
       */


      Interpreter.prototype.sender = function (event) {
        return this.send.bind(this, event);
      };
      /**
       * Returns the next state given the interpreter's current state and the event.
       *
       * This is a pure method that does _not_ update the interpreter's state.
       *
       * @param event The event to determine the next state
       */


      Interpreter.prototype.nextState = function (event) {
        var _this = this;

        var _event = toSCXMLEvent(event);

        if (_event.name.indexOf(errorPlatform) === 0 && !this.state.nextEvents.some(function (nextEvent) {
          return nextEvent.indexOf(errorPlatform) === 0;
        })) {
          throw _event.data.data;
        }

        var nextState = withServiceScope(this, function () {
          return _this.machine.transition(_this.state, _event);
        });
        return nextState;
      };

      Interpreter.prototype.forward = function (event) {
        var e_12, _a;

        try {
          for (var _b = __values(this.forwardTo), _c = _b.next(); !_c.done; _c = _b.next()) {
            var id = _c.value;
            var child = this.children.get(id);

            if (!child) {
              throw new Error("Unable to forward event '" + event + "' from interpreter '" + this.id + "' to nonexistant child '" + id + "'.");
            }

            child.send(event);
          }
        } catch (e_12_1) {
          e_12 = {
            error: e_12_1
          };
        } finally {
          try {
            if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
          } finally {
            if (e_12) throw e_12.error;
          }
        }
      };

      Interpreter.prototype.defer = function (sendAction) {
        var _this = this;

        this.delayedEventsMap[sendAction.id] = this.clock.setTimeout(function () {
          if (sendAction.to) {
            _this.sendTo(sendAction._event, sendAction.to);
          } else {
            _this.send(sendAction._event);
          }
        }, sendAction.delay);
      };

      Interpreter.prototype.cancel = function (sendId) {
        this.clock.clearTimeout(this.delayedEventsMap[sendId]);
        delete this.delayedEventsMap[sendId];
      };

      Interpreter.prototype.exec = function (action, state, actionFunctionMap) {
        var context = state.context,
            _event = state._event;
        var actionOrExec = getActionFunction(action.type, actionFunctionMap) || action.exec;
        var exec = isFunction(actionOrExec) ? actionOrExec : actionOrExec ? actionOrExec.exec : action.exec;

        if (exec) {
          // @ts-ignore (TODO: fix for TypeDoc)
          return exec(context, _event.data, {
            action: action,
            state: this.state
          });
        }

        switch (action.type) {
          case send:
            var sendAction = action;

            if (typeof sendAction.delay === 'number') {
              this.defer(sendAction);
              return;
            } else {
              if (sendAction.to) {
                this.sendTo(sendAction._event, sendAction.to);
              } else {
                this.send(sendAction._event);
              }
            }

            break;

          case cancel:
            this.cancel(action.sendId);
            break;

          case start:
            {
              var activity = action.activity; // If the activity will be stopped right after it's started
              // (such as in transient states)
              // don't bother starting the activity.

              if (!this.state.activities[activity.type]) {
                break;
              } // Invoked services


              if (activity.type === ActionTypes.Invoke) {
                var serviceCreator = this.machine.options.services ? this.machine.options.services[activity.src] : undefined;
                var id = activity.id,
                    data = activity.data;

                var autoForward = 'autoForward' in activity ? activity.autoForward : !!activity.forward;

                if (!serviceCreator) {

                  return;
                }

                var source = isFunction(serviceCreator) ? serviceCreator(context, _event.data) : serviceCreator;

                if (isPromiseLike(source)) {
                  this.state.children[id] = this.spawnPromise(Promise.resolve(source), id);
                } else if (isFunction(source)) {
                  this.state.children[id] = this.spawnCallback(source, id);
                } else if (isObservable(source)) {
                  this.state.children[id] = this.spawnObservable(source, id);
                } else if (isMachine(source)) {
                  // TODO: try/catch here
                  this.state.children[id] = this.spawnMachine(data ? source.withContext(mapContext(data, context, _event)) : source, {
                    id: id,
                    autoForward: autoForward
                  });
                }
              } else {
                this.spawnActivity(activity);
              }

              break;
            }

          case stop:
            {
              this.stopChild(action.activity.id);
              break;
            }

          case log:
            var label = action.label,
                value = action.value;

            if (label) {
              this.logger(label, value);
            } else {
              this.logger(value);
            }

            break;

          default:

            break;
        }

        return undefined;
      };

      Interpreter.prototype.stopChild = function (childId) {
        var child = this.children.get(childId);

        if (!child) {
          return;
        }

        this.children.delete(childId);
        this.forwardTo.delete(childId);
        delete this.state.children[childId];

        if (isFunction(child.stop)) {
          child.stop();
        }
      };

      Interpreter.prototype.spawn = function (entity, name, options) {
        if (isPromiseLike(entity)) {
          return this.spawnPromise(Promise.resolve(entity), name);
        } else if (isFunction(entity)) {
          return this.spawnCallback(entity, name);
        } else if (isObservable(entity)) {
          return this.spawnObservable(entity, name);
        } else if (isMachine(entity)) {
          return this.spawnMachine(entity, __assign(__assign({}, options), {
            id: name
          }));
        } else {
          throw new Error("Unable to spawn entity \"" + name + "\" of type \"" + typeof entity + "\".");
        }
      };

      Interpreter.prototype.spawnMachine = function (machine, options) {
        var _this = this;

        if (options === void 0) {
          options = {};
        }

        var childService = new Interpreter(machine, __assign(__assign({}, this.options), {
          parent: this,
          id: options.id || machine.id
        }));

        var resolvedOptions = __assign(__assign({}, DEFAULT_SPAWN_OPTIONS), options);

        if (resolvedOptions.sync) {
          childService.onTransition(function (state) {
            _this.send(update$1, {
              state: state,
              id: childService.id
            });
          });
        }

        childService.onDone(function (doneEvent) {
          _this.send(toSCXMLEvent(doneEvent, {
            origin: childService.id
          }));
        }).start();
        var actor = childService; // const actor = {
        //   id: childService.id,
        //   send: childService.send,
        //   state: childService.state,
        //   subscribe: childService.subscribe,
        //   toJSON() {
        //     return { id: childService.id };
        //   }
        // } as Actor<State<TChildContext, TChildEvents>>;

        this.children.set(childService.id, actor);

        if (resolvedOptions.autoForward) {
          this.forwardTo.add(childService.id);
        }

        return actor;
      };

      Interpreter.prototype.spawnPromise = function (promise, id) {
        var _this = this;

        var canceled = false;
        promise.then(function (response) {
          if (!canceled) {
            _this.send(toSCXMLEvent(doneInvoke(id, response), {
              origin: id
            }));
          }
        }, function (errorData) {
          if (!canceled) {
            var errorEvent = error(id, errorData);

            try {
              // Send "error.platform.id" to this (parent).
              _this.send(toSCXMLEvent(errorEvent, {
                origin: id
              }));
            } catch (error) {

              if (_this.devTools) {
                _this.devTools.send(errorEvent, _this.state);
              }

              if (_this.machine.strict) {
                // it would be better to always stop the state machine if unhandled
                // exception/promise rejection happens but because we don't want to
                // break existing code so enforce it on strict mode only especially so
                // because documentation says that onError is optional
                _this.stop();
              }
            }
          }
        });
        var actor = {
          id: id,
          send: function () {
            return void 0;
          },
          subscribe: function (next, handleError, complete) {
            var unsubscribed = false;
            promise.then(function (response) {
              if (unsubscribed) {
                return;
              }

              next && next(response);

              if (unsubscribed) {
                return;
              }

              complete && complete();
            }, function (err) {
              if (unsubscribed) {
                return;
              }

              handleError(err);
            });
            return {
              unsubscribe: function () {
                return unsubscribed = true;
              }
            };
          },
          stop: function () {
            canceled = true;
          },
          toJSON: function () {
            return {
              id: id
            };
          }
        };
        this.children.set(id, actor);
        return actor;
      };

      Interpreter.prototype.spawnCallback = function (callback, id) {
        var _this = this;

        var canceled = false;
        var receivers = new Set();
        var listeners = new Set();

        var receive = function (e) {
          listeners.forEach(function (listener) {
            return listener(e);
          });

          if (canceled) {
            return;
          }

          _this.send(e);
        };

        var callbackStop;

        try {
          callbackStop = callback(receive, function (newListener) {
            receivers.add(newListener);
          });
        } catch (err) {
          this.send(error(id, err));
        }

        if (isPromiseLike(callbackStop)) {
          // it turned out to be an async function, can't reliably check this before calling `callback`
          // because transpiled async functions are not recognizable
          return this.spawnPromise(callbackStop, id);
        }

        var actor = {
          id: id,
          send: function (event) {
            return receivers.forEach(function (receiver) {
              return receiver(event);
            });
          },
          subscribe: function (next) {
            listeners.add(next);
            return {
              unsubscribe: function () {
                listeners.delete(next);
              }
            };
          },
          stop: function () {
            canceled = true;

            if (isFunction(callbackStop)) {
              callbackStop();
            }
          },
          toJSON: function () {
            return {
              id: id
            };
          }
        };
        this.children.set(id, actor);
        return actor;
      };

      Interpreter.prototype.spawnObservable = function (source, id) {
        var _this = this;

        var subscription = source.subscribe(function (value) {
          _this.send(toSCXMLEvent(value, {
            origin: id
          }));
        }, function (err) {
          _this.send(toSCXMLEvent(error(id, err), {
            origin: id
          }));
        }, function () {
          _this.send(toSCXMLEvent(doneInvoke(id), {
            origin: id
          }));
        });
        var actor = {
          id: id,
          send: function () {
            return void 0;
          },
          subscribe: function (next, handleError, complete) {
            return source.subscribe(next, handleError, complete);
          },
          stop: function () {
            return subscription.unsubscribe();
          },
          toJSON: function () {
            return {
              id: id
            };
          }
        };
        this.children.set(id, actor);
        return actor;
      };

      Interpreter.prototype.spawnActivity = function (activity) {
        var implementation = this.machine.options && this.machine.options.activities ? this.machine.options.activities[activity.type] : undefined;

        if (!implementation) {


          return;
        } // Start implementation


        var dispose = implementation(this.state.context, activity);
        this.spawnEffect(activity.id, dispose);
      };

      Interpreter.prototype.spawnEffect = function (id, dispose) {
        this.children.set(id, {
          id: id,
          send: function () {
            return void 0;
          },
          subscribe: function () {
            return {
              unsubscribe: function () {
                return void 0;
              }
            };
          },
          stop: dispose || undefined,
          toJSON: function () {
            return {
              id: id
            };
          }
        });
      };

      Interpreter.prototype.attachDev = function () {
        if (this.options.devTools && typeof window !== 'undefined' && window.__REDUX_DEVTOOLS_EXTENSION__) {
          var devToolsOptions = typeof this.options.devTools === 'object' ? this.options.devTools : undefined;
          this.devTools = window.__REDUX_DEVTOOLS_EXTENSION__.connect(__assign(__assign({
            name: this.id,
            autoPause: true,
            stateSanitizer: function (state) {
              return {
                value: state.value,
                context: state.context,
                actions: state.actions
              };
            }
          }, devToolsOptions), {
            features: __assign({
              jump: false,
              skip: false
            }, devToolsOptions ? devToolsOptions.features : undefined)
          }), this.machine);
          this.devTools.init(this.state);
        }
      };

      Interpreter.prototype.toJSON = function () {
        return {
          id: this.id
        };
      };
      /**
       * The default interpreter options:
       *
       * - `clock` uses the global `setTimeout` and `clearTimeout` functions
       * - `logger` uses the global `console.log()` method
       */


      Interpreter.defaultOptions =
      /*#__PURE__*/
      function (global) {
        return {
          execute: true,
          deferEvents: true,
          clock: {
            setTimeout: function (fn, ms) {
              return global.setTimeout.call(null, fn, ms);
            },
            clearTimeout: function (id) {
              return global.clearTimeout.call(null, id);
            }
          },
          logger: global.console.log.bind(console),
          devTools: false
        };
      }(typeof window === 'undefined' ? global : window);

      Interpreter.interpret = interpret;
      return Interpreter;
    }();
    /**
     * Creates a new Interpreter instance for the given machine with the provided options, if any.
     *
     * @param machine The machine to interpret
     * @param options Interpreter options
     */


    function interpret(machine, options) {
      var interpreter = new Interpreter(machine, options);
      return interpreter;
    }

    var actions = {
      raise: raise$1,
      send: send$1,
      sendParent: sendParent,
      log: log$1,
      cancel: cancel$1,
      start: start$1,
      stop: stop$1,
      assign: assign$2,
      after: after$1,
      done: done,
      respond: respond
    };

    /*! xstate-component-tree@1.0.0 !*/
    const loader = async ({ item, key, fn, context, event }) => {
        item[key] = await fn(context, event);
    };

    class ComponentTree {
        constructor(interpreter, callback, options = {}) {
            // Storing off args
            this.interpreter = interpreter;
            this.callback = callback;
            this.options = options;

            // identifier!
            this._id = interpreter.id;

            // path -> meta lookup
            this._paths = new Map();

            // Get goin
            this._prep();
            this._watch();
        }

        teardown() {
            this._paths.clear();

            this._unsubscribe();
        }

        // Walk the machine and build up maps of paths to meta info as
        // well as prepping any load functions for usage later
        _prep() {
            const { _paths } = this;
            const { idMap : ids } = this.interpreter.machine;

            // xstate maps ids to state nodes, but the value object only
            // has paths, so need to create our own path-only map here
            for(const id in ids) {
                const { path, meta = false } = ids[id];

                const key = path.join(".");

                if(!meta) {
                    continue;
                }

                const { component, props, load } = meta;

                _paths.set(key, {
                    __proto__ : null,

                    component,
                    props,
                    load,
                });
            }
        }

        // Watch the machine for changes
        _watch() {
            const { interpreter } = this;
        
            const { unsubscribe } = interpreter.subscribe(this._state.bind(this));

            this._unsubscribe = unsubscribe;

            // In case the machine is already started, run a first pass on it
            if(interpreter.initialized) {
                this._state(interpreter.state);
            }
        }

        // Walk a machine via BFS, collecting meta information to build a tree
        // eslint-disable-next-line max-statements
        async _walk({ value, context, event }) {
            const { _paths } = this;
            
            const loads = [];
            const tree = {
                __proto__ : null,
                children  : [],
                id        : this._id,
            };

            // Set up queue for a breadth-first traversal of all active states
            let queue;

            if(typeof value === "string") {
                queue = [[ tree, value, false ]];
            } else {
                queue = Object.entries(value).map(([ child, grandchildren ]) =>
                    [ tree, child, grandchildren ]
                );
            }

            while(queue.length) {
                const [ parent, path, values ] = queue.shift();

                // Since it can be assigned if we add a new child
                let pointer = parent;

                if(_paths.has(path)) {
                    const { component, props, load } = _paths.get(path);
                    const item = {
                        __proto__ : null,
                        children  : [],
                        component : component || false,
                        props     : props || false,
                    };

                    // Run load function and assign the response to the component prop
                    if(load) {
                        loads.push(loader({
                            item,
                            key : "component",
                            fn  : load,
                            context,
                            event,
                        }));
                    }

                    // Props as a function means they're dynamic, so run it to get the value
                    if(typeof props === "function") {
                        loads.push(loader({
                            item,
                            key : "props",
                            fn  : props,
                            context,
                            event,
                        }));
                    }

                    parent.children.push(item);

                    pointer = item;
                }

                if(!values) {
                    continue;
                }

                if(typeof values === "string") {
                    queue.push([ pointer, `${path}.${values}`, false ]);

                    continue;
                }

                queue.push(...Object.entries(values).map(([ child, grandchildren ]) =>
                    [ pointer, `${path}.${child}`, grandchildren ]
                ));
            }

            // await all the load functions
            await Promise.all(loads);

            return tree;
        }
        
        // eslint-disable-next-line max-statements
        async _state(state) {
            const { changed, value, context, event } = state;

            // Need to specifically check for false because this value is undefined
            // when a machine first boots up
            if(changed === false) {
                return;
            }

            const tree = await this._walk({ value, context, event });
            
            this.callback(tree);
        }
    }

    const treeBuilder = (interpreter, fn) => {
        const machines = new Map();
        const trees = new Map();

        const root = interpreter.id;

        const respond = () => {
            fn([ ...trees.values() ]);
        };

        machines.set(root, new ComponentTree(interpreter, (tree) => {
            trees.set(root, tree);

            respond();
        }));

        interpreter.subscribe(({ changed, children }) => {
            if(changed === false) {
                return;
            }

            // BFS Walk child statecharts, attach subscribers for each of them
            const queue = Object.entries(children);
            
            // Track active ids
            const active = new Set();

            while(queue.length) {
                const [ id, machine ] = queue.shift();

                active.add(id);

                if(machine.initialized && machine.state) {
                    machines.set(id, new ComponentTree(machine, (tree) => {
                        trees.set(id, tree);

                        respond();
                    }));

                    queue.push(...Object.entries(machine.state.children));
                }
            }

            // Remove any no-longer active invoked statecharts from being tracked
            machines.forEach((cancel, id) => {
                if(active.has(id) || id === root) {
                    return;
                }

                machines.get(id).teardown();
                machines.delete(id);
                trees.delete(id);

                respond();
            });
        });

        return () => {
            machines.forEach((machine) => machine.teardown());
            machines.clear();
            trees.clear();
        };
    };

    treeBuilder.ComponentTree = ComponentTree;

    const subscriber_queue = [];
    /**
     * Creates a `Readable` store that allows reading by subscription.
     * @param value initial value
     * @param {StartStopNotifier}start start and stop notifications for subscriptions
     */
    function readable(value, start) {
        return {
            subscribe: writable(value, start).subscribe,
        };
    }
    /**
     * Create a `Writable` store that allows both updating and reading by subscription.
     * @param {*=}value initial value
     * @param {StartStopNotifier=}start start and stop notifications for subscriptions
     */
    function writable(value, start = noop) {
        let stop;
        const subscribers = [];
        function set(new_value) {
            if (safe_not_equal(value, new_value)) {
                value = new_value;
                if (stop) { // store is ready
                    const run_queue = !subscriber_queue.length;
                    for (let i = 0; i < subscribers.length; i += 1) {
                        const s = subscribers[i];
                        s[1]();
                        subscriber_queue.push(s, value);
                    }
                    if (run_queue) {
                        for (let i = 0; i < subscriber_queue.length; i += 2) {
                            subscriber_queue[i][0](subscriber_queue[i + 1]);
                        }
                        subscriber_queue.length = 0;
                    }
                }
            }
        }
        function update(fn) {
            set(fn(value));
        }
        function subscribe(run, invalidate = noop) {
            const subscriber = [run, invalidate];
            subscribers.push(subscriber);
            if (subscribers.length === 1) {
                stop = start(set) || noop;
            }
            run(value);
            return () => {
                const index = subscribers.indexOf(subscriber);
                if (index !== -1) {
                    subscribers.splice(index, 1);
                }
                if (subscribers.length === 0) {
                    stop();
                    stop = null;
                }
            };
        }
        return { set, update, subscribe };
    }
    /**
     * Derived value store by synchronizing one or more readable stores and
     * applying an aggregation function over its input values.
     * @param {Stores} stores input stores
     * @param {function(Stores=, function(*)=):*}fn function callback that aggregates the values
     * @param {*=}initial_value when used asynchronously
     */
    function derived(stores, fn, initial_value) {
        const single = !Array.isArray(stores);
        const stores_array = single
            ? [stores]
            : stores;
        const auto = fn.length < 2;
        return readable(initial_value, (set) => {
            let inited = false;
            const values = [];
            let pending = 0;
            let cleanup = noop;
            const sync = () => {
                if (pending) {
                    return;
                }
                cleanup();
                const result = fn(single ? values[0] : values, set);
                if (auto) {
                    set(result);
                }
                else {
                    cleanup = is_function(result) ? result : noop;
                }
            };
            const unsubscribers = stores_array.map((store, i) => store.subscribe((value) => {
                values[i] = value;
                pending &= ~(1 << i);
                if (inited) {
                    sync();
                }
            }, () => {
                pending |= (1 << i);
            }));
            inited = true;
            sync();
            return function stop() {
                run_all(unsubscribers);
                cleanup();
            };
        });
    }

    const quadrants = ["FRONT_RIGHT", "FRONT_LEFT", "BACK_LEFT", "BACK_RIGHT"]; // NOTE: The Deck editor orders strings as FR - FL - BL - BR

    const weapon = writable("barehands");

    const equip = armament => weapon.set(armament);

    const equipped = () => get_store_value(weapon);

    window.equip = equip;

    /**
     * Generate an empty deck slot object
     */

    const empty$1 = () => Object.assign(Object.create(null), {
      // Metadata for each cell to tell if it's empty, as well as
      // offer convenient pointers to its neighbors
      _meta: {
        empty: true,
        begins: false,
        ends: false
      }
    });
    /**
     * A factory function to generate a combo of length `length`
     * that comes complete with a default structure. This is used to generate
     * the primary strings (`combo(3)`) and alternate strings (`combo(1)`)
     * @param {Number} length
     */


    const combo = length => {
      const results = [];
      quadrants.forEach(() => {
        let attacks = Array.from(Array(length), empty$1);
        attacks = attacks.map(empty$1);
        attacks.forEach((attack, i) => {
          const next = attacks[i + 1] || false;
          const previous = attacks[i - 1] || false;
          const {
            _meta
          } = attack;
          _meta.next = next;
          _meta.previous = previous;
        });
        results.push(attacks);
      });
      return results;
    };
    /**
     * A function that takes a combo and runs through its attacks and
     * sets its _meta properties based contextually on the attacks that come before/after it.
     *
     * @param {Array} chain - An array of attacks to be walked and modified in-place
     */


    const configure = (quadrant, attacks) => {
      const armament = equipped();
      attacks.forEach(attack => {
        const {
          _meta
        } = attack;
        const {
          previous
        } = _meta;
        const {
          stance = false
        } = attack;
        const atkstance = stance[armament]; // This attack isn't empty if it has a name.

        _meta.empty = !attack.name; // If there's no previous move

        if (!_meta.previous) {
          // The current cell's beginning is defaulted to the quadrant it belongs to
          _meta.begins = quadrant; // The ending is either the quadrant, or if we have attack data, the ending for the attack.

          _meta.ends = _meta.empty ? quadrant : atkstance[_meta.begins];
          return;
        }
        /**
         * This attack begins where the previous one left off. But if there
         * is no previous attack, it's defaulted to the quadrant in the combo
         * this attack belongs to.
         */


        _meta.begins = previous._meta.empty ? quadrant : previous._meta.ends;
        _meta.ends = _meta.empty ? quadrant : atkstance[_meta.begins];
        return;
      });
      return;
    }; // Sets an attack at a location


    const insert$1 = (section, slot, attack) => {
      section.update(data => {
        const attacks = data[slot.row];
        Object.assign(attacks[slot.column], attack);
        return data;
      });
      return;
    }; // Remove an attack at a location


    const remove = (section, slot, subsequent = false) => {
      section.update(data => {
        let attacks = data[slot.row]; // !subsequent means we're not deleting all the stuff that comes after the target,

        if (!subsequent) {
          const attack = row[slot.column]; // Overwrite the meta object EXCEPT for linked list references.

          const _meta = Object.assign(attack._meta, empty$1()._meta); // Create a new object that's empty but contains metadata


          Object.assign(Object.create(null), {
            _meta
          });
          return data;
        }

        data[slot.row] = attacks.map((attack, index) => {
          if (index < slot.column) {
            return attack;
          } // Overwrite the meta object EXCEPT for linked list references.


          const _meta = Object.assign(attack._meta, empty$1()._meta); // Create a new object that's empty but contains metadata


          return Object.assign(Object.create(null), {
            _meta
          });
        });
        return data;
      });
    };

    // strings and alternates in our deck.

    const primaries = writable(combo(3));
    const alternates = writable(combo(1)); // Derive a deck object that keeps the most up to date deck attack / stance flow information

    const deck = derived([primaries, alternates], ([_p, _a], set) => {
      // Use side effects to configure both the primary section attacks and the
      // Alternate attacks. This is run every time primaries or alternates is updated.
      // NOTE: This can probably be greatly optimized, but right now 8 arrays of < 4 elements each is... trivial.
      const map = quadrants.map((quadrant, current) => {
        const p = _p[current];
        const a = _a[current];
        configure(quadrant, p);
        configure(quadrant, a);
        return {
          quadrant,
          primary: p,
          alternate: a
        };
      });
      set(map);
    });
    const equipped$1 = derived([primaries, alternates], ([_p, _a], set) => {
      const attacks = [..._p, ..._a];
      const reduced = attacks.reduce((collector, current) => [...collector, ...current], []);
      const names = reduced.map(({
        name = ""
      }) => name);
      set(names);
    });
    const selected = writable(false); // Glowing Stance icon

    const followup = derived([selected, weapon], ([_selected, _weapon], set) => {
      const {
        _meta = false
      } = _selected;

      if (!_selected || !_meta) {
        return;
      }

      if (_meta.empty) {
        set(false);
        return;
      }

      const {
        stance
      } = _selected;
      const {
        begins
      } = _meta;
      set(stance[_weapon][begins]);
    }, false);

    const reset = () => {
      primaries.set(combo(3));
      alternates.set(combo(1));
    };

    const matches = (service, lookup) => {
      const selector = lookup.split(".");
      let pointer = service.state.value;
      return selector.every(key => {
        if (typeof pointer === "string") {
          return key === pointer;
        }

        if (!pointer[key]) {
          return false;
        }

        pointer = pointer[key];
        return true;
      });
    };

    const statechart = (machine, options) => {
      // Create a statechart service that interprets
      // a passed in machine.
      const service = interpret(machine, options);
      const matching = matches.bind(null, service);
      const store = writable({
        __proto__: null,
        value: {},
        context: {},
        event: false,
        matches: matching
      });

      const update = ({
        value,
        event,
        context
      }) => {
        store.update(data => {
          data.value = value;
          data.event = event;
          data.context = context;
          return data;
        });
      };

      return {
        service,
        subscribe: store.subscribe,
        matches: matching,

        start() {
          service.onTransition(update);
          service.start();
          return service;
        },

        stop() {
          service.stop();
        },

        send(...args) {
          service.send(...args);
        }

      };
    };

    var barehands = [
    	{
    		name: "360 Tornado Kick",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 12,
    				guard: -1
    			}
    		},
    		modifiers: [
    			"jump"
    		]
    	},
    	{
    		name: "Ankle Stamp",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "low",
    		type: "thrust",
    		frames: {
    			startup: 11,
    			advantage: {
    				hit: 3,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Axe Kick",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 11,
    				guard: 7
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Back Fist",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 11,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Back Hop Wrist",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 10,
    			advantage: {
    				hit: 4,
    				guard: 0
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Back Tripped Kick",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 4,
    				guard: -1
    			}
    		},
    		modifiers: [
    			"duck"
    		]
    	},
    	{
    		name: "Back Turn Wrist",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 10,
    			advantage: {
    				hit: 3,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Back Ura",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 7,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Backfall Strike",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: false
    		},
    		hits: "diff",
    		lands: "high",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 7,
    				guard: 2
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Bending Palm",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: false
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 9,
    				guard: 8
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Blink Punch",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 10,
    			advantage: {
    				hit: 4,
    				guard: 0
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Body Blow",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 8,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"strafe"
    		]
    	},
    	{
    		name: "Bounce Knee",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 9,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"jump"
    		]
    	},
    	{
    		name: "Calbot",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 4,
    				guard: 1
    			}
    		},
    		modifiers: [
    			"strafe"
    		]
    	},
    	{
    		name: "Charged Haymaker",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 22,
    			advantage: {
    				hit: 10,
    				guard: 5
    			}
    		},
    		modifiers: [
    			"charge"
    		]
    	},
    	{
    		name: "Chin Palm",
    		style: "windfall",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Cleaver Blow",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 10,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Collar Chop",
    		style: "windfall",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 24,
    			advantage: {
    				hit: 15,
    				guard: 15
    			}
    		},
    		modifiers: [
    			"break"
    		]
    	},
    	{
    		name: "Cross Punch",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 8,
    				guard: 6
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Crouching Elbow",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Crushing Palm",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 9,
    				guard: 7
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Curled Up Uppercut",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 7,
    				guard: 6
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Direct Punch",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 10,
    			advantage: {
    				hit: 3,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Donkey Slap",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 8,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Double Fist Stretch",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: false
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 7,
    				guard: 1
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Double Palm",
    		style: "windfall",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: false
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 7,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Double Spike Kick",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 7,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Double Wata",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: false
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 8,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Drunk Crane",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: false
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Drunk Stomp",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 8,
    				guard: 6
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Drunken Paw",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: false
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 21,
    			advantage: {
    				hit: 13,
    				guard: 5
    			}
    		},
    		modifiers: [
    			"strafe"
    		]
    	},
    	{
    		name: "Drunken Smash",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: false
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 13,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Dwit Chagi",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 8,
    				guard: 7
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Elbow Stumble",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: false
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 7,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Eye Poke",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: false
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 8,
    				guard: 7
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Face Backfist",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 11,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Falcon Punch",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 22,
    			advantage: {
    				hit: 13,
    				guard: 6
    			}
    		},
    		modifiers: [
    			"jump"
    		]
    	},
    	{
    		name: "Fast Back Fist",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 10,
    			advantage: {
    				hit: 4,
    				guard: 0
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Fast Cross",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Fast Elbow",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 10,
    			advantage: {
    				hit: 3,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Fast Punch",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 8,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Fencing Punch",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 6,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Foot Slap",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 5,
    				guard: 0
    			}
    		},
    		modifiers: [
    			"jump"
    		]
    	},
    	{
    		name: "Front Kick",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 12,
    				guard: 12
    			}
    		},
    		modifiers: [
    			"break"
    		]
    	},
    	{
    		name: "Front Sweep",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 6,
    				guard: 2
    			}
    		},
    		modifiers: [
    			"duck"
    		]
    	},
    	{
    		name: "Furious Uppercut",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 22,
    			advantage: {
    				hit: 12,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"charge"
    		]
    	},
    	{
    		name: "Grab Punch",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 21,
    			advantage: {
    				hit: 11,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Gut Punch",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Guts Punch",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 12,
    				guard: 6
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Hadrunken",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: false
    		},
    		hits: "both",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 21,
    			advantage: {
    				hit: 10,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"charge"
    		]
    	},
    	{
    		name: "Hammer Kick",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 12,
    				guard: 12
    			}
    		},
    		modifiers: [
    			"break"
    		]
    	},
    	{
    		name: "Handstand Kick",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 7,
    				guard: -1
    			}
    		},
    		modifiers: [
    			"double",
    			"low"
    		]
    	},
    	{
    		name: "Heel to Knee",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "low",
    		type: "thrust",
    		frames: {
    			startup: 11,
    			advantage: {
    				hit: 4,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Hook",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		side: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Horse Kick",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 23,
    			advantage: {
    				hit: 13,
    				guard: 8
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Illusion Twist Kick",
    		style: "windfall",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 12,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"jump"
    		]
    	},
    	{
    		name: "Inside Kick",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Jab Punch",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 10,
    			advantage: {
    				hit: 4,
    				guard: 0
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Jackhammer Punch",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: false
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 10,
    				guard: 5
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Jar Bash",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: false
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 6,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Jump Out Elbow",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 21,
    			advantage: {
    				hit: 13,
    				guard: 13
    			}
    		},
    		modifiers: [
    			"break",
    			"jump"
    		]
    	},
    	{
    		name: "Jumped Light Kick",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 11,
    			advantage: {
    				hit: 3,
    				guard: 0
    			}
    		},
    		modifiers: [
    			"jump"
    		]
    	},
    	{
    		name: "Jumped Spin kick",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 23,
    			advantage: {
    				hit: 12,
    				guard: 6
    			}
    		},
    		modifiers: [
    			"jump"
    		]
    	},
    	{
    		name: "Jumping Risekick",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 10,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Knee Strike",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 12,
    				guard: 12
    			}
    		},
    		modifiers: [
    			"break",
    			"jump"
    		]
    	},
    	{
    		name: "Knife Hand Strike",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 10,
    			advantage: {
    				hit: 3,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Leg Breaker",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 10,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Light Sidekick",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Liver Knee",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 8,
    				guard: 6
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Low Backfist",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Low Kick",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 6,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Low Spin Heel",
    		style: "windfall",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 9,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"duck"
    		]
    	},
    	{
    		name: "Mawashi",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 10,
    			advantage: {
    				hit: 3,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Meia Lua",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 9,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"duck"
    		]
    	},
    	{
    		name: "Mill Punch",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: false
    		},
    		side: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 8,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "One Inch Punch",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 24,
    			advantage: {
    				hit: 15,
    				guard: 15
    			}
    		},
    		modifiers: [
    			"break"
    		]
    	},
    	{
    		name: "Outward Kick",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 7,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Parry & Strike",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		side: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 7,
    				guard: 2
    			}
    		},
    		modifiers: [
    			"parry"
    		]
    	},
    	{
    		name: "Plexus Elbow",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 12,
    				guard: 12
    			}
    		},
    		modifiers: [
    			"break"
    		]
    	},
    	{
    		name: "Power Mawashi",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 19,
    			advantage: {
    				hit: 11,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Pulmonary Palm",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: false
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 9,
    				guard: 8
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Pushed Back Kick",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 19,
    			advantage: {
    				hit: 11,
    				guard: 11
    			}
    		},
    		modifiers: [
    			"break"
    		]
    	},
    	{
    		name: "Pushed Elbow",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_LEFT"
    			}
    		},
    		side: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 7,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Rabbit Punch",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Reaching Maegeri",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 7,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Reaching Mawashi",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 9,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Rising Kick",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 7,
    				guard: 6
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Roll Back Fist",
    		style: "windfall",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 8,
    				guard: 2
    			}
    		},
    		modifiers: [
    			"strafe"
    		]
    	},
    	{
    		name: "Roll Punch",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 9,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"duck"
    		]
    	},
    	{
    		name: "Roll Uppercut",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 19,
    			advantage: {
    				hit: 11,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"duck"
    		]
    	},
    	{
    		name: "Run-up Strike",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_LEFT",
    				FRONT_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 21,
    			advantage: {
    				hit: 12,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Scissor Kick",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 8,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Side Kick",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 10,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Slap Kick",
    		style: "windfall",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 9,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"jump"
    		]
    	},
    	{
    		name: "Soto-uke",
    		style: "windfall",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Spin Back Fist",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 7,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Spin Elbow",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 11,
    			advantage: {
    				hit: 5,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Spinning Flute Swing",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: false
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 12,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Spinning High Kick",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 22,
    			advantage: {
    				hit: 14,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Spinning Wide Hook",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 23,
    			advantage: {
    				hit: 14,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Spiral Back Punch",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: false
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 10,
    				guard: 6
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Spiral Palm",
    		style: "windfall",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: false
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 24,
    			advantage: {
    				hit: 15,
    				guard: 15
    			}
    		},
    		modifiers: [
    			"break"
    		]
    	},
    	{
    		name: "Straight Punch",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 8,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Stretch Out Hook",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Surging Palm",
    		style: "windfall",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 12,
    				guard: 5
    			}
    		},
    		modifiers: [
    			"strafe"
    		]
    	},
    	{
    		name: "Switch Kick",
    		style: "faejin",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "low",
    		type: "thrust",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 7,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Temple Knock",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Tetsuzanko",
    		style: "windfall",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 10,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"strafe"
    		]
    	},
    	{
    		name: "Tripped Kick",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT",
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 5,
    				guard: 2
    			}
    		},
    		modifiers: [
    			"duck"
    		]
    	},
    	{
    		name: "Twist Back Kick",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 8,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Twist Parry Strike",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 9,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"parry"
    		]
    	},
    	{
    		name: "Underknee kick",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 6,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Upper Backfist",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 6,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Upper Elbow",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 23,
    			advantage: {
    				hit: 14,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Uraken",
    		style: "faejin",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_LEFT",
    				BACK_LEFT: "BACK_RIGHT"
    			},
    			sword: {
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Uramawashi",
    		style: "windfall",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			},
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT",
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 7,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Wallop Blow",
    		style: "kahlt",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "BACK_RIGHT",
    				BACK_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				BACK_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 7,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Whirlwind Double Punch",
    		style: "stagger",
    		stance: {
    			barehands: {
    				BACK_RIGHT: "FRONT_RIGHT",
    				BACK_LEFT: "FRONT_LEFT"
    			},
    			sword: false
    		},
    		hits: "same",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 7,
    				guard: 1
    			}
    		},
    		modifiers: [
    			"duck",
    			"double"
    		]
    	},
    	{
    		name: "Winged Back Kick",
    		style: "forsaken",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 8,
    				guard: 6
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Wobble Low Kick",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			},
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT",
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 5,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Wrist Jab",
    		style: "stagger",
    		stance: {
    			barehands: {
    				FRONT_RIGHT: "FRONT_RIGHT",
    				FRONT_LEFT: "FRONT_LEFT"
    			},
    			sword: false
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 11,
    			advantage: {
    				hit: 5,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	}
    ];

    var sword = [
    	{
    		name: "Arc Slash",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 9,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Body Slicing",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 23,
    			advantage: {
    				hit: 13,
    				guard: 14
    			}
    		},
    		modifiers: [
    			"break"
    		]
    	},
    	{
    		name: "Buchinmo",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 21,
    			advantage: {
    				hit: 10,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"charge"
    		]
    	},
    	{
    		name: "Kitsueno Cut",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Shifting Thrust",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 7,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Corkscrew Thrust",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 11,
    			advantage: {
    				hit: 3,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Dash Slash",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 11,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Digging Parry Elbow",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 9,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"parry"
    		]
    	},
    	{
    		name: "Double Thrust",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 6,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Drop Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 12,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Kitsueno Cut",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 4,
    				guard: -1
    			}
    		},
    		modifiers: [
    			"duck"
    		]
    	},
    	{
    		name: "Duster Blow",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Forward Lean Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 22,
    			advantage: {
    				hit: 14,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Front Stab",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 6,
    				guard: 5
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Gatotsu",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 11,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Gokai Slash",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 8,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Ground Swell Slash",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 8,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Head Splitter",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 9,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Hook Slash",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Inward Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 11,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Keen Crouch",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 8,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"duck"
    		]
    	},
    	{
    		name: "Kitsueno Cut",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 7,
    				guard: 2
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Leg Stroke",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Light Swing Slash",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 11,
    			advantage: {
    				hit: 4,
    				guard: 0
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Light Thrust",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 8,
    				guard: 6
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Limbo Thrust",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 6,
    				guard: 2
    			}
    		},
    		modifiers: [
    			"duck"
    		]
    	},
    	{
    		name: "Mill Slash",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 6,
    				guard: 2
    			}
    		},
    		modifiers: [
    			"duck"
    		]
    	},
    	{
    		name: "Neck Slash",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 6,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Needle Point",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Nose Stab",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 11,
    			advantage: {
    				hit: 4,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Obvious Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "both",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 22,
    			advantage: {
    				hit: 14,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "One Handed Slash",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "DIFF",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 6,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Overhead Slash",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 11,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Painstaking Slash",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 8,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Parry Pommel Bash",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 11,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"parry"
    		]
    	},
    	{
    		name: "Parry Reverse Low Slash",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 10,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"parry"
    		]
    	},
    	{
    		name: "Parry Shove",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 19,
    			advantage: {
    				hit: 10,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"parry"
    		]
    	},
    	{
    		name: "Parry Slash",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 24,
    			advantage: {
    				hit: 13,
    				guard: 6
    			}
    		},
    		modifiers: [
    			"parry"
    		]
    	},
    	{
    		name: "Poke Thrust",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 11,
    			advantage: {
    				hit: 3,
    				guard: 2
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Pommel Bash",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 10,
    				guard: 10
    			}
    		},
    		modifiers: [
    			"break"
    		]
    	},
    	{
    		name: "Puropera Cut",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 21,
    			advantage: {
    				hit: 13,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Ram Thrust",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 7,
    				guard: 6
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Reverse Feet Thrust",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "low",
    		type: "thrust",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 12,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Reverse Hips Slash",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Reverse One Handed Slash",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 7,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Reverse Rising Slash",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Reverse Rising Thrust",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 10,
    				guard: 6
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Reverse Sharp Slash",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 22,
    			advantage: {
    				hit: 13,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Reverse Twist Slash",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 8,
    				guard: 6
    			}
    		},
    		modifiers: [
    			"stop"
    		]
    	},
    	{
    		name: "Rising Double Hand",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 9,
    				guard: 9
    			}
    		},
    		modifiers: [
    			"break"
    		]
    	},
    	{
    		name: "Rising Slash",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Rising Spin Slash",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 12,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Seven Star Thrust",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 22,
    			advantage: {
    				hit: 14,
    				guard: 5
    			}
    		},
    		modifiers: [
    			"strafe"
    		]
    	},
    	{
    		name: "Shapu Furiko",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "thrust",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 9,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Shifting Thrust",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 5,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Sickle Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 9,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Side Thrust",
    		style: "kahlt",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "different",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 8,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Side Wind Thrust",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "thrust",
    		frames: {
    			startup: 21,
    			advantage: {
    				hit: 13,
    				guard: 5
    			}
    		},
    		modifiers: [
    			"strafe"
    		]
    	},
    	{
    		name: "Slip Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 7,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Spiral Slash",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 11,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Spoon Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 9,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Stumble Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 21,
    			advantage: {
    				hit: 13,
    				guard: 6
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Swirl Slash",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 21,
    			advantage: {
    				hit: 13,
    				guard: 13
    			}
    		},
    		modifiers: [
    			"break"
    		]
    	},
    	{
    		name: "Tei-nami",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "low",
    		type: "thrust",
    		frames: {
    			startup: 12,
    			advantage: {
    				hit: 6,
    				guard: 4
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Tendon Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 16,
    			advantage: {
    				hit: 8,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Thigh Slash",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "same",
    		height: "low",
    		type: "horizontal",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 6,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Thunder Slash",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "BACK_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 23,
    			advantage: {
    				hit: 14,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Toreador Slash",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 7,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"strafe"
    		]
    	},
    	{
    		name: "Twist Hips Slash",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "FRONT_LEFT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 20,
    			advantage: {
    				hit: 13,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Typhoon Slash",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 7,
    				guard: -1
    			}
    		},
    		modifiers: [
    			"double"
    		]
    	},
    	{
    		name: "Up Slash",
    		style: "faejin",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_RIGHT: "BACK_LEFT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 9,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Vertical Slash",
    		style: "forsaken",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "FRONT_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 17,
    			advantage: {
    				hit: 10,
    				guard: 5
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Whirl Slash",
    		style: "windfall",
    		stance: {
    			barehands: false,
    			sword: {
    				FRONT_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 18,
    			advantage: {
    				hit: 10,
    				guard: 3
    			}
    		},
    		modifiers: [
    			"jump"
    		]
    	},
    	{
    		name: "Wide Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 14,
    			advantage: {
    				hit: 8,
    				guard: 3
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Woosh Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_LEFT: "BACK_RIGHT"
    			}
    		},
    		hits: "diff",
    		height: "high",
    		type: "horizontal",
    		frames: {
    			startup: 13,
    			advantage: {
    				hit: 7,
    				guard: 1
    			}
    		},
    		modifiers: [
    		]
    	},
    	{
    		name: "Wrist Roll Slash",
    		style: "stagger",
    		stance: {
    			barehands: false,
    			sword: {
    				BACK_RIGHT: "FRONT_RIGHT"
    			}
    		},
    		hits: "same",
    		height: "mid",
    		type: "vertical",
    		frames: {
    			startup: 15,
    			advantage: {
    				hit: 9,
    				guard: 4
    			}
    		},
    		modifiers: [
    		]
    	}
    ];

    const all = [...barehands, ...sword];

    const cache = new Map();
    /**
     * Given some arbitrary quadrant data, runs through the move pool
     * and determines which moves will take you from your passed in position
     * to each of the known stance quadrants.
     *
     * @param {Object} source - The quadrant you want to move from e.g. "FRONT_LEFT"
     *
     * @returns {Object} A Map of move options that can originate from the source
     */

    const followups = (source, options = false) => {
      const attacks = all;
      const armament = equipped();

      if (!source) {
        return false;
      } // Should we exclude any quadrants?


      const {
        exclude = []
      } = options;
      const alternate = exclude.length; // Thus far, the only reason I have an options object is because
      // I need to exclude stuff for alts, so this works.

      const key = `${armament}-${source}-${alternate ? "alt" : "pri"}`; // Return an existing pool if we've already done this work

      if (cache.has(key)) {
        return cache.get(key);
      }

      const pool = []; // For each quadrant, find out the moves
      // That will take you from the source quadrant to
      // the target quadrant (e.g. FRONT_RIGHT to BACK_LEFT)

      quadrants.forEach(quadrant => {
        // If the current quadrant is blacklisted, don't bother.
        if (exclude.includes(quadrant)) {
          return;
        }

        let data = attacks.filter(attack => {
          const stance = attack.stance[armament];
          const keys = Object.keys(stance);
          /**
           * The stance object has to have a key that matches our `source`.
           * Additionally, the VALUE of that key (attack.stance[key] e.g. FRONT_RIGHT) needs
           * to match the quadrant we're currently iterating over.
          */

          return keys.includes(source) && stance[source] === quadrant;
        }); // Giveth me an object with metadata and attacks, brethren

        pool.push({
          stance: quadrant,
          attacks: data
        });
      }); // Set this key for the cache so we can save off this stuff for later.

      cache.set(key, pool);
      return pool;
    };

    /**
     *
     * @param {Object} target - A deck slot where `attack` will be placed.
     * @param {*} attack - An attack object that will be slotted into `target`
     */

    const compatible = (target, attack) => {
      const armament = equipped();
      const {
        next,
        previous
      } = target._meta;
      const {
        _meta: after
      } = next;
      const {
        _meta: before
      } = previous;
      const stance = attack.stance[armament];
      const endings = Object.values(stance);
      const beginnings = Object.keys(stance);
      const predicates = [// VALID: the move you're trying to slot ends where the next move begins
      // OR there's no move in the next slot.
      !next || after.empty || endings.includes(after.begins), // VALID: The move you're trying to slot already begins in the right stance where the previous move ends
      // OR there's no previous move.
      !previous || before.empty || beginnings.includes(before.ends)]; // If any predicate fails here, this configuration is incompatible

      return predicates.every(Boolean);
    };

    var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

    function unwrapExports (x) {
    	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
    }

    function createCommonjsModule(fn, module) {
    	return module = { exports: {} }, fn(module, module.exports), module.exports;
    }

    var howler = createCommonjsModule(function (module, exports) {
    /*!
     *  howler.js v2.1.2
     *  howlerjs.com
     *
     *  (c) 2013-2019, James Simpson of GoldFire Studios
     *  goldfirestudios.com
     *
     *  MIT License
     */

    (function() {

      /** Global Methods **/
      /***************************************************************************/

      /**
       * Create the global controller. All contained methods and properties apply
       * to all sounds that are currently playing or will be in the future.
       */
      var HowlerGlobal = function() {
        this.init();
      };
      HowlerGlobal.prototype = {
        /**
         * Initialize the global Howler object.
         * @return {Howler}
         */
        init: function() {
          var self = this || Howler;

          // Create a global ID counter.
          self._counter = 1000;

          // Pool of unlocked HTML5 Audio objects.
          self._html5AudioPool = [];
          self.html5PoolSize = 10;

          // Internal properties.
          self._codecs = {};
          self._howls = [];
          self._muted = false;
          self._volume = 1;
          self._canPlayEvent = 'canplaythrough';
          self._navigator = (typeof window !== 'undefined' && window.navigator) ? window.navigator : null;

          // Public properties.
          self.masterGain = null;
          self.noAudio = false;
          self.usingWebAudio = true;
          self.autoSuspend = true;
          self.ctx = null;

          // Set to false to disable the auto audio unlocker.
          self.autoUnlock = true;

          // Setup the various state values for global tracking.
          self._setup();

          return self;
        },

        /**
         * Get/set the global volume for all sounds.
         * @param  {Float} vol Volume from 0.0 to 1.0.
         * @return {Howler/Float}     Returns self or current volume.
         */
        volume: function(vol) {
          var self = this || Howler;
          vol = parseFloat(vol);

          // If we don't have an AudioContext created yet, run the setup.
          if (!self.ctx) {
            setupAudioContext();
          }

          if (typeof vol !== 'undefined' && vol >= 0 && vol <= 1) {
            self._volume = vol;

            // Don't update any of the nodes if we are muted.
            if (self._muted) {
              return self;
            }

            // When using Web Audio, we just need to adjust the master gain.
            if (self.usingWebAudio) {
              self.masterGain.gain.setValueAtTime(vol, Howler.ctx.currentTime);
            }

            // Loop through and change volume for all HTML5 audio nodes.
            for (var i=0; i<self._howls.length; i++) {
              if (!self._howls[i]._webAudio) {
                // Get all of the sounds in this Howl group.
                var ids = self._howls[i]._getSoundIds();

                // Loop through all sounds and change the volumes.
                for (var j=0; j<ids.length; j++) {
                  var sound = self._howls[i]._soundById(ids[j]);

                  if (sound && sound._node) {
                    sound._node.volume = sound._volume * vol;
                  }
                }
              }
            }

            return self;
          }

          return self._volume;
        },

        /**
         * Handle muting and unmuting globally.
         * @param  {Boolean} muted Is muted or not.
         */
        mute: function(muted) {
          var self = this || Howler;

          // If we don't have an AudioContext created yet, run the setup.
          if (!self.ctx) {
            setupAudioContext();
          }

          self._muted = muted;

          // With Web Audio, we just need to mute the master gain.
          if (self.usingWebAudio) {
            self.masterGain.gain.setValueAtTime(muted ? 0 : self._volume, Howler.ctx.currentTime);
          }

          // Loop through and mute all HTML5 Audio nodes.
          for (var i=0; i<self._howls.length; i++) {
            if (!self._howls[i]._webAudio) {
              // Get all of the sounds in this Howl group.
              var ids = self._howls[i]._getSoundIds();

              // Loop through all sounds and mark the audio node as muted.
              for (var j=0; j<ids.length; j++) {
                var sound = self._howls[i]._soundById(ids[j]);

                if (sound && sound._node) {
                  sound._node.muted = (muted) ? true : sound._muted;
                }
              }
            }
          }

          return self;
        },

        /**
         * Unload and destroy all currently loaded Howl objects.
         * @return {Howler}
         */
        unload: function() {
          var self = this || Howler;

          for (var i=self._howls.length-1; i>=0; i--) {
            self._howls[i].unload();
          }

          // Create a new AudioContext to make sure it is fully reset.
          if (self.usingWebAudio && self.ctx && typeof self.ctx.close !== 'undefined') {
            self.ctx.close();
            self.ctx = null;
            setupAudioContext();
          }

          return self;
        },

        /**
         * Check for codec support of specific extension.
         * @param  {String} ext Audio file extention.
         * @return {Boolean}
         */
        codecs: function(ext) {
          return (this || Howler)._codecs[ext.replace(/^x-/, '')];
        },

        /**
         * Setup various state values for global tracking.
         * @return {Howler}
         */
        _setup: function() {
          var self = this || Howler;

          // Keeps track of the suspend/resume state of the AudioContext.
          self.state = self.ctx ? self.ctx.state || 'suspended' : 'suspended';

          // Automatically begin the 30-second suspend process
          self._autoSuspend();

          // Check if audio is available.
          if (!self.usingWebAudio) {
            // No audio is available on this system if noAudio is set to true.
            if (typeof Audio !== 'undefined') {
              try {
                var test = new Audio();

                // Check if the canplaythrough event is available.
                if (typeof test.oncanplaythrough === 'undefined') {
                  self._canPlayEvent = 'canplay';
                }
              } catch(e) {
                self.noAudio = true;
              }
            } else {
              self.noAudio = true;
            }
          }

          // Test to make sure audio isn't disabled in Internet Explorer.
          try {
            var test = new Audio();
            if (test.muted) {
              self.noAudio = true;
            }
          } catch (e) {}

          // Check for supported codecs.
          if (!self.noAudio) {
            self._setupCodecs();
          }

          return self;
        },

        /**
         * Check for browser support for various codecs and cache the results.
         * @return {Howler}
         */
        _setupCodecs: function() {
          var self = this || Howler;
          var audioTest = null;

          // Must wrap in a try/catch because IE11 in server mode throws an error.
          try {
            audioTest = (typeof Audio !== 'undefined') ? new Audio() : null;
          } catch (err) {
            return self;
          }

          if (!audioTest || typeof audioTest.canPlayType !== 'function') {
            return self;
          }

          var mpegTest = audioTest.canPlayType('audio/mpeg;').replace(/^no$/, '');

          // Opera version <33 has mixed MP3 support, so we need to check for and block it.
          var checkOpera = self._navigator && self._navigator.userAgent.match(/OPR\/([0-6].)/g);
          var isOldOpera = (checkOpera && parseInt(checkOpera[0].split('/')[1], 10) < 33);

          self._codecs = {
            mp3: !!(!isOldOpera && (mpegTest || audioTest.canPlayType('audio/mp3;').replace(/^no$/, ''))),
            mpeg: !!mpegTest,
            opus: !!audioTest.canPlayType('audio/ogg; codecs="opus"').replace(/^no$/, ''),
            ogg: !!audioTest.canPlayType('audio/ogg; codecs="vorbis"').replace(/^no$/, ''),
            oga: !!audioTest.canPlayType('audio/ogg; codecs="vorbis"').replace(/^no$/, ''),
            wav: !!audioTest.canPlayType('audio/wav; codecs="1"').replace(/^no$/, ''),
            aac: !!audioTest.canPlayType('audio/aac;').replace(/^no$/, ''),
            caf: !!audioTest.canPlayType('audio/x-caf;').replace(/^no$/, ''),
            m4a: !!(audioTest.canPlayType('audio/x-m4a;') || audioTest.canPlayType('audio/m4a;') || audioTest.canPlayType('audio/aac;')).replace(/^no$/, ''),
            mp4: !!(audioTest.canPlayType('audio/x-mp4;') || audioTest.canPlayType('audio/mp4;') || audioTest.canPlayType('audio/aac;')).replace(/^no$/, ''),
            weba: !!audioTest.canPlayType('audio/webm; codecs="vorbis"').replace(/^no$/, ''),
            webm: !!audioTest.canPlayType('audio/webm; codecs="vorbis"').replace(/^no$/, ''),
            dolby: !!audioTest.canPlayType('audio/mp4; codecs="ec-3"').replace(/^no$/, ''),
            flac: !!(audioTest.canPlayType('audio/x-flac;') || audioTest.canPlayType('audio/flac;')).replace(/^no$/, '')
          };

          return self;
        },

        /**
         * Some browsers/devices will only allow audio to be played after a user interaction.
         * Attempt to automatically unlock audio on the first user interaction.
         * Concept from: http://paulbakaus.com/tutorials/html5/web-audio-on-ios/
         * @return {Howler}
         */
        _unlockAudio: function() {
          var self = this || Howler;

          // Only run this if Web Audio is supported and it hasn't already been unlocked.
          if (self._audioUnlocked || !self.ctx) {
            return;
          }

          self._audioUnlocked = false;
          self.autoUnlock = false;

          // Some mobile devices/platforms have distortion issues when opening/closing tabs and/or web views.
          // Bugs in the browser (especially Mobile Safari) can cause the sampleRate to change from 44100 to 48000.
          // By calling Howler.unload(), we create a new AudioContext with the correct sampleRate.
          if (!self._mobileUnloaded && self.ctx.sampleRate !== 44100) {
            self._mobileUnloaded = true;
            self.unload();
          }

          // Scratch buffer for enabling iOS to dispose of web audio buffers correctly, as per:
          // http://stackoverflow.com/questions/24119684
          self._scratchBuffer = self.ctx.createBuffer(1, 1, 22050);

          // Call this method on touch start to create and play a buffer,
          // then check if the audio actually played to determine if
          // audio has now been unlocked on iOS, Android, etc.
          var unlock = function(e) {
            // Create a pool of unlocked HTML5 Audio objects that can
            // be used for playing sounds without user interaction. HTML5
            // Audio objects must be individually unlocked, as opposed
            // to the WebAudio API which only needs a single activation.
            // This must occur before WebAudio setup or the source.onended
            // event will not fire.
            for (var i=0; i<self.html5PoolSize; i++) {
              try {
                var audioNode = new Audio();

                // Mark this Audio object as unlocked to ensure it can get returned
                // to the unlocked pool when released.
                audioNode._unlocked = true;

                // Add the audio node to the pool.
                self._releaseHtml5Audio(audioNode);
              } catch (e) {
                self.noAudio = true;
              }
            }

            // Loop through any assigned audio nodes and unlock them.
            for (var i=0; i<self._howls.length; i++) {
              if (!self._howls[i]._webAudio) {
                // Get all of the sounds in this Howl group.
                var ids = self._howls[i]._getSoundIds();

                // Loop through all sounds and unlock the audio nodes.
                for (var j=0; j<ids.length; j++) {
                  var sound = self._howls[i]._soundById(ids[j]);

                  if (sound && sound._node && !sound._node._unlocked) {
                    sound._node._unlocked = true;
                    sound._node.load();
                  }
                }
              }
            }

            // Fix Android can not play in suspend state.
            self._autoResume();

            // Create an empty buffer.
            var source = self.ctx.createBufferSource();
            source.buffer = self._scratchBuffer;
            source.connect(self.ctx.destination);

            // Play the empty buffer.
            if (typeof source.start === 'undefined') {
              source.noteOn(0);
            } else {
              source.start(0);
            }

            // Calling resume() on a stack initiated by user gesture is what actually unlocks the audio on Android Chrome >= 55.
            if (typeof self.ctx.resume === 'function') {
              self.ctx.resume();
            }

            // Setup a timeout to check that we are unlocked on the next event loop.
            source.onended = function() {
              source.disconnect(0);

              // Update the unlocked state and prevent this check from happening again.
              self._audioUnlocked = true;

              // Remove the touch start listener.
              document.removeEventListener('touchstart', unlock, true);
              document.removeEventListener('touchend', unlock, true);
              document.removeEventListener('click', unlock, true);

              // Let all sounds know that audio has been unlocked.
              for (var i=0; i<self._howls.length; i++) {
                self._howls[i]._emit('unlock');
              }
            };
          };

          // Setup a touch start listener to attempt an unlock in.
          document.addEventListener('touchstart', unlock, true);
          document.addEventListener('touchend', unlock, true);
          document.addEventListener('click', unlock, true);

          return self;
        },

        /**
         * Get an unlocked HTML5 Audio object from the pool. If none are left,
         * return a new Audio object and throw a warning.
         * @return {Audio} HTML5 Audio object.
         */
        _obtainHtml5Audio: function() {
          var self = this || Howler;

          // Return the next object from the pool if one exists.
          if (self._html5AudioPool.length) {
            return self._html5AudioPool.pop();
          }

          //.Check if the audio is locked and throw a warning.
          var testPlay = new Audio().play();
          if (testPlay && typeof Promise !== 'undefined' && (testPlay instanceof Promise || typeof testPlay.then === 'function')) {
            testPlay.catch(function() {
              console.warn('HTML5 Audio pool exhausted, returning potentially locked audio object.');
            });
          }

          return new Audio();
        },

        /**
         * Return an activated HTML5 Audio object to the pool.
         * @return {Howler}
         */
        _releaseHtml5Audio: function(audio) {
          var self = this || Howler;

          // Don't add audio to the pool if we don't know if it has been unlocked.
          if (audio._unlocked) {
            self._html5AudioPool.push(audio);
          }

          return self;
        },

        /**
         * Automatically suspend the Web Audio AudioContext after no sound has played for 30 seconds.
         * This saves processing/energy and fixes various browser-specific bugs with audio getting stuck.
         * @return {Howler}
         */
        _autoSuspend: function() {
          var self = this;

          if (!self.autoSuspend || !self.ctx || typeof self.ctx.suspend === 'undefined' || !Howler.usingWebAudio) {
            return;
          }

          // Check if any sounds are playing.
          for (var i=0; i<self._howls.length; i++) {
            if (self._howls[i]._webAudio) {
              for (var j=0; j<self._howls[i]._sounds.length; j++) {
                if (!self._howls[i]._sounds[j]._paused) {
                  return self;
                }
              }
            }
          }

          if (self._suspendTimer) {
            clearTimeout(self._suspendTimer);
          }

          // If no sound has played after 30 seconds, suspend the context.
          self._suspendTimer = setTimeout(function() {
            if (!self.autoSuspend) {
              return;
            }

            self._suspendTimer = null;
            self.state = 'suspending';
            self.ctx.suspend().then(function() {
              self.state = 'suspended';

              if (self._resumeAfterSuspend) {
                delete self._resumeAfterSuspend;
                self._autoResume();
              }
            });
          }, 30000);

          return self;
        },

        /**
         * Automatically resume the Web Audio AudioContext when a new sound is played.
         * @return {Howler}
         */
        _autoResume: function() {
          var self = this;

          if (!self.ctx || typeof self.ctx.resume === 'undefined' || !Howler.usingWebAudio) {
            return;
          }

          if (self.state === 'running' && self._suspendTimer) {
            clearTimeout(self._suspendTimer);
            self._suspendTimer = null;
          } else if (self.state === 'suspended') {
            self.ctx.resume().then(function() {
              self.state = 'running';

              // Emit to all Howls that the audio has resumed.
              for (var i=0; i<self._howls.length; i++) {
                self._howls[i]._emit('resume');
              }
            });

            if (self._suspendTimer) {
              clearTimeout(self._suspendTimer);
              self._suspendTimer = null;
            }
          } else if (self.state === 'suspending') {
            self._resumeAfterSuspend = true;
          }

          return self;
        }
      };

      // Setup the global audio controller.
      var Howler = new HowlerGlobal();

      /** Group Methods **/
      /***************************************************************************/

      /**
       * Create an audio group controller.
       * @param {Object} o Passed in properties for this group.
       */
      var Howl = function(o) {
        var self = this;

        // Throw an error if no source is provided.
        if (!o.src || o.src.length === 0) {
          console.error('An array of source files must be passed with any new Howl.');
          return;
        }

        self.init(o);
      };
      Howl.prototype = {
        /**
         * Initialize a new Howl group object.
         * @param  {Object} o Passed in properties for this group.
         * @return {Howl}
         */
        init: function(o) {
          var self = this;

          // If we don't have an AudioContext created yet, run the setup.
          if (!Howler.ctx) {
            setupAudioContext();
          }

          // Setup user-defined default properties.
          self._autoplay = o.autoplay || false;
          self._format = (typeof o.format !== 'string') ? o.format : [o.format];
          self._html5 = o.html5 || false;
          self._muted = o.mute || false;
          self._loop = o.loop || false;
          self._pool = o.pool || 5;
          self._preload = (typeof o.preload === 'boolean') ? o.preload : true;
          self._rate = o.rate || 1;
          self._sprite = o.sprite || {};
          self._src = (typeof o.src !== 'string') ? o.src : [o.src];
          self._volume = o.volume !== undefined ? o.volume : 1;
          self._xhrWithCredentials = o.xhrWithCredentials || false;

          // Setup all other default properties.
          self._duration = 0;
          self._state = 'unloaded';
          self._sounds = [];
          self._endTimers = {};
          self._queue = [];
          self._playLock = false;

          // Setup event listeners.
          self._onend = o.onend ? [{fn: o.onend}] : [];
          self._onfade = o.onfade ? [{fn: o.onfade}] : [];
          self._onload = o.onload ? [{fn: o.onload}] : [];
          self._onloaderror = o.onloaderror ? [{fn: o.onloaderror}] : [];
          self._onplayerror = o.onplayerror ? [{fn: o.onplayerror}] : [];
          self._onpause = o.onpause ? [{fn: o.onpause}] : [];
          self._onplay = o.onplay ? [{fn: o.onplay}] : [];
          self._onstop = o.onstop ? [{fn: o.onstop}] : [];
          self._onmute = o.onmute ? [{fn: o.onmute}] : [];
          self._onvolume = o.onvolume ? [{fn: o.onvolume}] : [];
          self._onrate = o.onrate ? [{fn: o.onrate}] : [];
          self._onseek = o.onseek ? [{fn: o.onseek}] : [];
          self._onunlock = o.onunlock ? [{fn: o.onunlock}] : [];
          self._onresume = [];

          // Web Audio or HTML5 Audio?
          self._webAudio = Howler.usingWebAudio && !self._html5;

          // Automatically try to enable audio.
          if (typeof Howler.ctx !== 'undefined' && Howler.ctx && Howler.autoUnlock) {
            Howler._unlockAudio();
          }

          // Keep track of this Howl group in the global controller.
          Howler._howls.push(self);

          // If they selected autoplay, add a play event to the load queue.
          if (self._autoplay) {
            self._queue.push({
              event: 'play',
              action: function() {
                self.play();
              }
            });
          }

          // Load the source file unless otherwise specified.
          if (self._preload) {
            self.load();
          }

          return self;
        },

        /**
         * Load the audio file.
         * @return {Howler}
         */
        load: function() {
          var self = this;
          var url = null;

          // If no audio is available, quit immediately.
          if (Howler.noAudio) {
            self._emit('loaderror', null, 'No audio support.');
            return;
          }

          // Make sure our source is in an array.
          if (typeof self._src === 'string') {
            self._src = [self._src];
          }

          // Loop through the sources and pick the first one that is compatible.
          for (var i=0; i<self._src.length; i++) {
            var ext, str;

            if (self._format && self._format[i]) {
              // If an extension was specified, use that instead.
              ext = self._format[i];
            } else {
              // Make sure the source is a string.
              str = self._src[i];
              if (typeof str !== 'string') {
                self._emit('loaderror', null, 'Non-string found in selected audio sources - ignoring.');
                continue;
              }

              // Extract the file extension from the URL or base64 data URI.
              ext = /^data:audio\/([^;,]+);/i.exec(str);
              if (!ext) {
                ext = /\.([^.]+)$/.exec(str.split('?', 1)[0]);
              }

              if (ext) {
                ext = ext[1].toLowerCase();
              }
            }

            // Log a warning if no extension was found.
            if (!ext) {
              console.warn('No file extension was found. Consider using the "format" property or specify an extension.');
            }

            // Check if this extension is available.
            if (ext && Howler.codecs(ext)) {
              url = self._src[i];
              break;
            }
          }

          if (!url) {
            self._emit('loaderror', null, 'No codec support for selected audio sources.');
            return;
          }

          self._src = url;
          self._state = 'loading';

          // If the hosting page is HTTPS and the source isn't,
          // drop down to HTML5 Audio to avoid Mixed Content errors.
          if (window.location.protocol === 'https:' && url.slice(0, 5) === 'http:') {
            self._html5 = true;
            self._webAudio = false;
          }

          // Create a new sound object and add it to the pool.
          new Sound(self);

          // Load and decode the audio data for playback.
          if (self._webAudio) {
            loadBuffer(self);
          }

          return self;
        },

        /**
         * Play a sound or resume previous playback.
         * @param  {String/Number} sprite   Sprite name for sprite playback or sound id to continue previous.
         * @param  {Boolean} internal Internal Use: true prevents event firing.
         * @return {Number}          Sound ID.
         */
        play: function(sprite, internal) {
          var self = this;
          var id = null;

          // Determine if a sprite, sound id or nothing was passed
          if (typeof sprite === 'number') {
            id = sprite;
            sprite = null;
          } else if (typeof sprite === 'string' && self._state === 'loaded' && !self._sprite[sprite]) {
            // If the passed sprite doesn't exist, do nothing.
            return null;
          } else if (typeof sprite === 'undefined') {
            // Use the default sound sprite (plays the full audio length).
            sprite = '__default';

            // Check if there is a single paused sound that isn't ended. 
            // If there is, play that sound. If not, continue as usual.  
            if (!self._playLock) {
              var num = 0;
              for (var i=0; i<self._sounds.length; i++) {
                if (self._sounds[i]._paused && !self._sounds[i]._ended) {
                  num++;
                  id = self._sounds[i]._id;
                }
              }

              if (num === 1) {
                sprite = null;
              } else {
                id = null;
              }
            }
          }

          // Get the selected node, or get one from the pool.
          var sound = id ? self._soundById(id) : self._inactiveSound();

          // If the sound doesn't exist, do nothing.
          if (!sound) {
            return null;
          }

          // Select the sprite definition.
          if (id && !sprite) {
            sprite = sound._sprite || '__default';
          }

          // If the sound hasn't loaded, we must wait to get the audio's duration.
          // We also need to wait to make sure we don't run into race conditions with
          // the order of function calls.
          if (self._state !== 'loaded') {
            // Set the sprite value on this sound.
            sound._sprite = sprite;

            // Mark this sound as not ended in case another sound is played before this one loads.
            sound._ended = false;

            // Add the sound to the queue to be played on load.
            var soundId = sound._id;
            self._queue.push({
              event: 'play',
              action: function() {
                self.play(soundId);
              }
            });

            return soundId;
          }

          // Don't play the sound if an id was passed and it is already playing.
          if (id && !sound._paused) {
            // Trigger the play event, in order to keep iterating through queue.
            if (!internal) {
              self._loadQueue('play');
            }

            return sound._id;
          }

          // Make sure the AudioContext isn't suspended, and resume it if it is.
          if (self._webAudio) {
            Howler._autoResume();
          }

          // Determine how long to play for and where to start playing.
          var seek = Math.max(0, sound._seek > 0 ? sound._seek : self._sprite[sprite][0] / 1000);
          var duration = Math.max(0, ((self._sprite[sprite][0] + self._sprite[sprite][1]) / 1000) - seek);
          var timeout = (duration * 1000) / Math.abs(sound._rate);
          var start = self._sprite[sprite][0] / 1000;
          var stop = (self._sprite[sprite][0] + self._sprite[sprite][1]) / 1000;
          var loop = !!(sound._loop || self._sprite[sprite][2]);
          sound._sprite = sprite;

          // Mark the sound as ended instantly so that this async playback
          // doesn't get grabbed by another call to play while this one waits to start.
          sound._ended = false;

          // Update the parameters of the sound.
          var setParams = function() {
            sound._paused = false;
            sound._seek = seek;
            sound._start = start;
            sound._stop = stop;
            sound._loop = loop;
          };

          // End the sound instantly if seek is at the end.
          if (seek >= stop) {
            self._ended(sound);
            return;
          }

          // Begin the actual playback.
          var node = sound._node;
          if (self._webAudio) {
            // Fire this when the sound is ready to play to begin Web Audio playback.
            var playWebAudio = function() {
              self._playLock = false;
              setParams();
              self._refreshBuffer(sound);

              // Setup the playback params.
              var vol = (sound._muted || self._muted) ? 0 : sound._volume;
              node.gain.setValueAtTime(vol, Howler.ctx.currentTime);
              sound._playStart = Howler.ctx.currentTime;

              // Play the sound using the supported method.
              if (typeof node.bufferSource.start === 'undefined') {
                sound._loop ? node.bufferSource.noteGrainOn(0, seek, 86400) : node.bufferSource.noteGrainOn(0, seek, duration);
              } else {
                sound._loop ? node.bufferSource.start(0, seek, 86400) : node.bufferSource.start(0, seek, duration);
              }

              // Start a new timer if none is present.
              if (timeout !== Infinity) {
                self._endTimers[sound._id] = setTimeout(self._ended.bind(self, sound), timeout);
              }

              if (!internal) {
                setTimeout(function() {
                  self._emit('play', sound._id);
                  self._loadQueue();
                }, 0);
              }
            };

            if (Howler.state === 'running') {
              playWebAudio();
            } else {
              self._playLock = true;

              // Wait for the audio context to resume before playing.
              self.once('resume', playWebAudio);

              // Cancel the end timer.
              self._clearTimer(sound._id);
            }
          } else {
            // Fire this when the sound is ready to play to begin HTML5 Audio playback.
            var playHtml5 = function() {
              node.currentTime = seek;
              node.muted = sound._muted || self._muted || Howler._muted || node.muted;
              node.volume = sound._volume * Howler.volume();
              node.playbackRate = sound._rate;

              // Some browsers will throw an error if this is called without user interaction.
              try {
                var play = node.play();

                // Support older browsers that don't support promises, and thus don't have this issue.
                if (play && typeof Promise !== 'undefined' && (play instanceof Promise || typeof play.then === 'function')) {
                  // Implements a lock to prevent DOMException: The play() request was interrupted by a call to pause().
                  self._playLock = true;

                  // Set param values immediately.
                  setParams();

                  // Releases the lock and executes queued actions.
                  play
                    .then(function() {
                      self._playLock = false;
                      node._unlocked = true;
                      if (!internal) {
                        self._emit('play', sound._id);
                        self._loadQueue();
                      }
                    })
                    .catch(function() {
                      self._playLock = false;
                      self._emit('playerror', sound._id, 'Playback was unable to start. This is most commonly an issue ' +
                        'on mobile devices and Chrome where playback was not within a user interaction.');

                      // Reset the ended and paused values.
                      sound._ended = true;
                      sound._paused = true;
                    });
                } else if (!internal) {
                  self._playLock = false;
                  setParams();
                  self._emit('play', sound._id);
                  self._loadQueue();
                }

                // Setting rate before playing won't work in IE, so we set it again here.
                node.playbackRate = sound._rate;

                // If the node is still paused, then we can assume there was a playback issue.
                if (node.paused) {
                  self._emit('playerror', sound._id, 'Playback was unable to start. This is most commonly an issue ' +
                    'on mobile devices and Chrome where playback was not within a user interaction.');
                  return;
                }

                // Setup the end timer on sprites or listen for the ended event.
                if (sprite !== '__default' || sound._loop) {
                  self._endTimers[sound._id] = setTimeout(self._ended.bind(self, sound), timeout);
                } else {
                  self._endTimers[sound._id] = function() {
                    // Fire ended on this audio node.
                    self._ended(sound);

                    // Clear this listener.
                    node.removeEventListener('ended', self._endTimers[sound._id], false);
                  };
                  node.addEventListener('ended', self._endTimers[sound._id], false);
                }
              } catch (err) {
                self._emit('playerror', sound._id, err);
              }
            };

            // If this is streaming audio, make sure the src is set and load again.
            if (node.src === 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA') {
              node.src = self._src;
              node.load();
            }

            // Play immediately if ready, or wait for the 'canplaythrough'e vent.
            var loadedNoReadyState = (window && window.ejecta) || (!node.readyState && Howler._navigator.isCocoonJS);
            if (node.readyState >= 3 || loadedNoReadyState) {
              playHtml5();
            } else {
              self._playLock = true;

              var listener = function() {
                // Begin playback.
                playHtml5();

                // Clear this listener.
                node.removeEventListener(Howler._canPlayEvent, listener, false);
              };
              node.addEventListener(Howler._canPlayEvent, listener, false);

              // Cancel the end timer.
              self._clearTimer(sound._id);
            }
          }

          return sound._id;
        },

        /**
         * Pause playback and save current position.
         * @param  {Number} id The sound ID (empty to pause all in group).
         * @return {Howl}
         */
        pause: function(id) {
          var self = this;

          // If the sound hasn't loaded or a play() promise is pending, add it to the load queue to pause when capable.
          if (self._state !== 'loaded' || self._playLock) {
            self._queue.push({
              event: 'pause',
              action: function() {
                self.pause(id);
              }
            });

            return self;
          }

          // If no id is passed, get all ID's to be paused.
          var ids = self._getSoundIds(id);

          for (var i=0; i<ids.length; i++) {
            // Clear the end timer.
            self._clearTimer(ids[i]);

            // Get the sound.
            var sound = self._soundById(ids[i]);

            if (sound && !sound._paused) {
              // Reset the seek position.
              sound._seek = self.seek(ids[i]);
              sound._rateSeek = 0;
              sound._paused = true;

              // Stop currently running fades.
              self._stopFade(ids[i]);

              if (sound._node) {
                if (self._webAudio) {
                  // Make sure the sound has been created.
                  if (!sound._node.bufferSource) {
                    continue;
                  }

                  if (typeof sound._node.bufferSource.stop === 'undefined') {
                    sound._node.bufferSource.noteOff(0);
                  } else {
                    sound._node.bufferSource.stop(0);
                  }

                  // Clean up the buffer source.
                  self._cleanBuffer(sound._node);
                } else if (!isNaN(sound._node.duration) || sound._node.duration === Infinity) {
                  sound._node.pause();
                }
              }
            }

            // Fire the pause event, unless `true` is passed as the 2nd argument.
            if (!arguments[1]) {
              self._emit('pause', sound ? sound._id : null);
            }
          }

          return self;
        },

        /**
         * Stop playback and reset to start.
         * @param  {Number} id The sound ID (empty to stop all in group).
         * @param  {Boolean} internal Internal Use: true prevents event firing.
         * @return {Howl}
         */
        stop: function(id, internal) {
          var self = this;

          // If the sound hasn't loaded, add it to the load queue to stop when capable.
          if (self._state !== 'loaded' || self._playLock) {
            self._queue.push({
              event: 'stop',
              action: function() {
                self.stop(id);
              }
            });

            return self;
          }

          // If no id is passed, get all ID's to be stopped.
          var ids = self._getSoundIds(id);

          for (var i=0; i<ids.length; i++) {
            // Clear the end timer.
            self._clearTimer(ids[i]);

            // Get the sound.
            var sound = self._soundById(ids[i]);

            if (sound) {
              // Reset the seek position.
              sound._seek = sound._start || 0;
              sound._rateSeek = 0;
              sound._paused = true;
              sound._ended = true;

              // Stop currently running fades.
              self._stopFade(ids[i]);

              if (sound._node) {
                if (self._webAudio) {
                  // Make sure the sound's AudioBufferSourceNode has been created.
                  if (sound._node.bufferSource) {
                    if (typeof sound._node.bufferSource.stop === 'undefined') {
                      sound._node.bufferSource.noteOff(0);
                    } else {
                      sound._node.bufferSource.stop(0);
                    }

                    // Clean up the buffer source.
                    self._cleanBuffer(sound._node);
                  }
                } else if (!isNaN(sound._node.duration) || sound._node.duration === Infinity) {
                  sound._node.currentTime = sound._start || 0;
                  sound._node.pause();

                  // If this is a live stream, stop download once the audio is stopped.
                  if (sound._node.duration === Infinity) {
                    self._clearSound(sound._node);
                  }
                }
              }

              if (!internal) {
                self._emit('stop', sound._id);
              }
            }
          }

          return self;
        },

        /**
         * Mute/unmute a single sound or all sounds in this Howl group.
         * @param  {Boolean} muted Set to true to mute and false to unmute.
         * @param  {Number} id    The sound ID to update (omit to mute/unmute all).
         * @return {Howl}
         */
        mute: function(muted, id) {
          var self = this;

          // If the sound hasn't loaded, add it to the load queue to mute when capable.
          if (self._state !== 'loaded'|| self._playLock) {
            self._queue.push({
              event: 'mute',
              action: function() {
                self.mute(muted, id);
              }
            });

            return self;
          }

          // If applying mute/unmute to all sounds, update the group's value.
          if (typeof id === 'undefined') {
            if (typeof muted === 'boolean') {
              self._muted = muted;
            } else {
              return self._muted;
            }
          }

          // If no id is passed, get all ID's to be muted.
          var ids = self._getSoundIds(id);

          for (var i=0; i<ids.length; i++) {
            // Get the sound.
            var sound = self._soundById(ids[i]);

            if (sound) {
              sound._muted = muted;

              // Cancel active fade and set the volume to the end value.
              if (sound._interval) {
                self._stopFade(sound._id);
              }

              if (self._webAudio && sound._node) {
                sound._node.gain.setValueAtTime(muted ? 0 : sound._volume, Howler.ctx.currentTime);
              } else if (sound._node) {
                sound._node.muted = Howler._muted ? true : muted;
              }

              self._emit('mute', sound._id);
            }
          }

          return self;
        },

        /**
         * Get/set the volume of this sound or of the Howl group. This method can optionally take 0, 1 or 2 arguments.
         *   volume() -> Returns the group's volume value.
         *   volume(id) -> Returns the sound id's current volume.
         *   volume(vol) -> Sets the volume of all sounds in this Howl group.
         *   volume(vol, id) -> Sets the volume of passed sound id.
         * @return {Howl/Number} Returns self or current volume.
         */
        volume: function() {
          var self = this;
          var args = arguments;
          var vol, id;

          // Determine the values based on arguments.
          if (args.length === 0) {
            // Return the value of the groups' volume.
            return self._volume;
          } else if (args.length === 1 || args.length === 2 && typeof args[1] === 'undefined') {
            // First check if this is an ID, and if not, assume it is a new volume.
            var ids = self._getSoundIds();
            var index = ids.indexOf(args[0]);
            if (index >= 0) {
              id = parseInt(args[0], 10);
            } else {
              vol = parseFloat(args[0]);
            }
          } else if (args.length >= 2) {
            vol = parseFloat(args[0]);
            id = parseInt(args[1], 10);
          }

          // Update the volume or return the current volume.
          var sound;
          if (typeof vol !== 'undefined' && vol >= 0 && vol <= 1) {
            // If the sound hasn't loaded, add it to the load queue to change volume when capable.
            if (self._state !== 'loaded'|| self._playLock) {
              self._queue.push({
                event: 'volume',
                action: function() {
                  self.volume.apply(self, args);
                }
              });

              return self;
            }

            // Set the group volume.
            if (typeof id === 'undefined') {
              self._volume = vol;
            }

            // Update one or all volumes.
            id = self._getSoundIds(id);
            for (var i=0; i<id.length; i++) {
              // Get the sound.
              sound = self._soundById(id[i]);

              if (sound) {
                sound._volume = vol;

                // Stop currently running fades.
                if (!args[2]) {
                  self._stopFade(id[i]);
                }

                if (self._webAudio && sound._node && !sound._muted) {
                  sound._node.gain.setValueAtTime(vol, Howler.ctx.currentTime);
                } else if (sound._node && !sound._muted) {
                  sound._node.volume = vol * Howler.volume();
                }

                self._emit('volume', sound._id);
              }
            }
          } else {
            sound = id ? self._soundById(id) : self._sounds[0];
            return sound ? sound._volume : 0;
          }

          return self;
        },

        /**
         * Fade a currently playing sound between two volumes (if no id is passsed, all sounds will fade).
         * @param  {Number} from The value to fade from (0.0 to 1.0).
         * @param  {Number} to   The volume to fade to (0.0 to 1.0).
         * @param  {Number} len  Time in milliseconds to fade.
         * @param  {Number} id   The sound id (omit to fade all sounds).
         * @return {Howl}
         */
        fade: function(from, to, len, id) {
          var self = this;

          // If the sound hasn't loaded, add it to the load queue to fade when capable.
          if (self._state !== 'loaded' || self._playLock) {
            self._queue.push({
              event: 'fade',
              action: function() {
                self.fade(from, to, len, id);
              }
            });

            return self;
          }

          // Make sure the to/from/len values are numbers.
          from = parseFloat(from);
          to = parseFloat(to);
          len = parseFloat(len);

          // Set the volume to the start position.
          self.volume(from, id);

          // Fade the volume of one or all sounds.
          var ids = self._getSoundIds(id);
          for (var i=0; i<ids.length; i++) {
            // Get the sound.
            var sound = self._soundById(ids[i]);

            // Create a linear fade or fall back to timeouts with HTML5 Audio.
            if (sound) {
              // Stop the previous fade if no sprite is being used (otherwise, volume handles this).
              if (!id) {
                self._stopFade(ids[i]);
              }

              // If we are using Web Audio, let the native methods do the actual fade.
              if (self._webAudio && !sound._muted) {
                var currentTime = Howler.ctx.currentTime;
                var end = currentTime + (len / 1000);
                sound._volume = from;
                sound._node.gain.setValueAtTime(from, currentTime);
                sound._node.gain.linearRampToValueAtTime(to, end);
              }

              self._startFadeInterval(sound, from, to, len, ids[i], typeof id === 'undefined');
            }
          }

          return self;
        },

        /**
         * Starts the internal interval to fade a sound.
         * @param  {Object} sound Reference to sound to fade.
         * @param  {Number} from The value to fade from (0.0 to 1.0).
         * @param  {Number} to   The volume to fade to (0.0 to 1.0).
         * @param  {Number} len  Time in milliseconds to fade.
         * @param  {Number} id   The sound id to fade.
         * @param  {Boolean} isGroup   If true, set the volume on the group.
         */
        _startFadeInterval: function(sound, from, to, len, id, isGroup) {
          var self = this;
          var vol = from;
          var diff = to - from;
          var steps = Math.abs(diff / 0.01);
          var stepLen = Math.max(4, (steps > 0) ? len / steps : len);
          var lastTick = Date.now();

          // Store the value being faded to.
          sound._fadeTo = to;

          // Update the volume value on each interval tick.
          sound._interval = setInterval(function() {
            // Update the volume based on the time since the last tick.
            var tick = (Date.now() - lastTick) / len;
            lastTick = Date.now();
            vol += diff * tick;

            // Make sure the volume is in the right bounds.
            vol = Math.max(0, vol);
            vol = Math.min(1, vol);

            // Round to within 2 decimal points.
            vol = Math.round(vol * 100) / 100;

            // Change the volume.
            if (self._webAudio) {
              sound._volume = vol;
            } else {
              self.volume(vol, sound._id, true);
            }

            // Set the group's volume.
            if (isGroup) {
              self._volume = vol;
            }

            // When the fade is complete, stop it and fire event.
            if ((to < from && vol <= to) || (to > from && vol >= to)) {
              clearInterval(sound._interval);
              sound._interval = null;
              sound._fadeTo = null;
              self.volume(to, sound._id);
              self._emit('fade', sound._id);
            }
          }, stepLen);
        },

        /**
         * Internal method that stops the currently playing fade when
         * a new fade starts, volume is changed or the sound is stopped.
         * @param  {Number} id The sound id.
         * @return {Howl}
         */
        _stopFade: function(id) {
          var self = this;
          var sound = self._soundById(id);

          if (sound && sound._interval) {
            if (self._webAudio) {
              sound._node.gain.cancelScheduledValues(Howler.ctx.currentTime);
            }

            clearInterval(sound._interval);
            sound._interval = null;
            self.volume(sound._fadeTo, id);
            sound._fadeTo = null;
            self._emit('fade', id);
          }

          return self;
        },

        /**
         * Get/set the loop parameter on a sound. This method can optionally take 0, 1 or 2 arguments.
         *   loop() -> Returns the group's loop value.
         *   loop(id) -> Returns the sound id's loop value.
         *   loop(loop) -> Sets the loop value for all sounds in this Howl group.
         *   loop(loop, id) -> Sets the loop value of passed sound id.
         * @return {Howl/Boolean} Returns self or current loop value.
         */
        loop: function() {
          var self = this;
          var args = arguments;
          var loop, id, sound;

          // Determine the values for loop and id.
          if (args.length === 0) {
            // Return the grou's loop value.
            return self._loop;
          } else if (args.length === 1) {
            if (typeof args[0] === 'boolean') {
              loop = args[0];
              self._loop = loop;
            } else {
              // Return this sound's loop value.
              sound = self._soundById(parseInt(args[0], 10));
              return sound ? sound._loop : false;
            }
          } else if (args.length === 2) {
            loop = args[0];
            id = parseInt(args[1], 10);
          }

          // If no id is passed, get all ID's to be looped.
          var ids = self._getSoundIds(id);
          for (var i=0; i<ids.length; i++) {
            sound = self._soundById(ids[i]);

            if (sound) {
              sound._loop = loop;
              if (self._webAudio && sound._node && sound._node.bufferSource) {
                sound._node.bufferSource.loop = loop;
                if (loop) {
                  sound._node.bufferSource.loopStart = sound._start || 0;
                  sound._node.bufferSource.loopEnd = sound._stop;
                }
              }
            }
          }

          return self;
        },

        /**
         * Get/set the playback rate of a sound. This method can optionally take 0, 1 or 2 arguments.
         *   rate() -> Returns the first sound node's current playback rate.
         *   rate(id) -> Returns the sound id's current playback rate.
         *   rate(rate) -> Sets the playback rate of all sounds in this Howl group.
         *   rate(rate, id) -> Sets the playback rate of passed sound id.
         * @return {Howl/Number} Returns self or the current playback rate.
         */
        rate: function() {
          var self = this;
          var args = arguments;
          var rate, id;

          // Determine the values based on arguments.
          if (args.length === 0) {
            // We will simply return the current rate of the first node.
            id = self._sounds[0]._id;
          } else if (args.length === 1) {
            // First check if this is an ID, and if not, assume it is a new rate value.
            var ids = self._getSoundIds();
            var index = ids.indexOf(args[0]);
            if (index >= 0) {
              id = parseInt(args[0], 10);
            } else {
              rate = parseFloat(args[0]);
            }
          } else if (args.length === 2) {
            rate = parseFloat(args[0]);
            id = parseInt(args[1], 10);
          }

          // Update the playback rate or return the current value.
          var sound;
          if (typeof rate === 'number') {
            // If the sound hasn't loaded, add it to the load queue to change playback rate when capable.
            if (self._state !== 'loaded' || self._playLock) {
              self._queue.push({
                event: 'rate',
                action: function() {
                  self.rate.apply(self, args);
                }
              });

              return self;
            }

            // Set the group rate.
            if (typeof id === 'undefined') {
              self._rate = rate;
            }

            // Update one or all volumes.
            id = self._getSoundIds(id);
            for (var i=0; i<id.length; i++) {
              // Get the sound.
              sound = self._soundById(id[i]);

              if (sound) {
                // Keep track of our position when the rate changed and update the playback
                // start position so we can properly adjust the seek position for time elapsed.
                if (self.playing(id[i])) {
                  sound._rateSeek = self.seek(id[i]);
                  sound._playStart = self._webAudio ? Howler.ctx.currentTime : sound._playStart;
                }
                sound._rate = rate;

                // Change the playback rate.
                if (self._webAudio && sound._node && sound._node.bufferSource) {
                  sound._node.bufferSource.playbackRate.setValueAtTime(rate, Howler.ctx.currentTime);
                } else if (sound._node) {
                  sound._node.playbackRate = rate;
                }

                // Reset the timers.
                var seek = self.seek(id[i]);
                var duration = ((self._sprite[sound._sprite][0] + self._sprite[sound._sprite][1]) / 1000) - seek;
                var timeout = (duration * 1000) / Math.abs(sound._rate);

                // Start a new end timer if sound is already playing.
                if (self._endTimers[id[i]] || !sound._paused) {
                  self._clearTimer(id[i]);
                  self._endTimers[id[i]] = setTimeout(self._ended.bind(self, sound), timeout);
                }

                self._emit('rate', sound._id);
              }
            }
          } else {
            sound = self._soundById(id);
            return sound ? sound._rate : self._rate;
          }

          return self;
        },

        /**
         * Get/set the seek position of a sound. This method can optionally take 0, 1 or 2 arguments.
         *   seek() -> Returns the first sound node's current seek position.
         *   seek(id) -> Returns the sound id's current seek position.
         *   seek(seek) -> Sets the seek position of the first sound node.
         *   seek(seek, id) -> Sets the seek position of passed sound id.
         * @return {Howl/Number} Returns self or the current seek position.
         */
        seek: function() {
          var self = this;
          var args = arguments;
          var seek, id;

          // Determine the values based on arguments.
          if (args.length === 0) {
            // We will simply return the current position of the first node.
            id = self._sounds[0]._id;
          } else if (args.length === 1) {
            // First check if this is an ID, and if not, assume it is a new seek position.
            var ids = self._getSoundIds();
            var index = ids.indexOf(args[0]);
            if (index >= 0) {
              id = parseInt(args[0], 10);
            } else if (self._sounds.length) {
              id = self._sounds[0]._id;
              seek = parseFloat(args[0]);
            }
          } else if (args.length === 2) {
            seek = parseFloat(args[0]);
            id = parseInt(args[1], 10);
          }

          // If there is no ID, bail out.
          if (typeof id === 'undefined') {
            return self;
          }

          // If the sound hasn't loaded, add it to the load queue to seek when capable.
          if (self._state !== 'loaded' || self._playLock) {
            self._queue.push({
              event: 'seek',
              action: function() {
                self.seek.apply(self, args);
              }
            });

            return self;
          }

          // Get the sound.
          var sound = self._soundById(id);

          if (sound) {
            if (typeof seek === 'number' && seek >= 0) {
              // Pause the sound and update position for restarting playback.
              var playing = self.playing(id);
              if (playing) {
                self.pause(id, true);
              }

              // Move the position of the track and cancel timer.
              sound._seek = seek;
              sound._ended = false;
              self._clearTimer(id);

              // Update the seek position for HTML5 Audio.
              if (!self._webAudio && sound._node && !isNaN(sound._node.duration)) {
                sound._node.currentTime = seek;
              }

              // Seek and emit when ready.
              var seekAndEmit = function() {
                self._emit('seek', id);

                // Restart the playback if the sound was playing.
                if (playing) {
                  self.play(id, true);
                }
              };

              // Wait for the play lock to be unset before emitting (HTML5 Audio).
              if (playing && !self._webAudio) {
                var emitSeek = function() {
                  if (!self._playLock) {
                    seekAndEmit();
                  } else {
                    setTimeout(emitSeek, 0);
                  }
                };
                setTimeout(emitSeek, 0);
              } else {
                seekAndEmit();
              }
            } else {
              if (self._webAudio) {
                var realTime = self.playing(id) ? Howler.ctx.currentTime - sound._playStart : 0;
                var rateSeek = sound._rateSeek ? sound._rateSeek - sound._seek : 0;
                return sound._seek + (rateSeek + realTime * Math.abs(sound._rate));
              } else {
                return sound._node.currentTime;
              }
            }
          }

          return self;
        },

        /**
         * Check if a specific sound is currently playing or not (if id is provided), or check if at least one of the sounds in the group is playing or not.
         * @param  {Number}  id The sound id to check. If none is passed, the whole sound group is checked.
         * @return {Boolean} True if playing and false if not.
         */
        playing: function(id) {
          var self = this;

          // Check the passed sound ID (if any).
          if (typeof id === 'number') {
            var sound = self._soundById(id);
            return sound ? !sound._paused : false;
          }

          // Otherwise, loop through all sounds and check if any are playing.
          for (var i=0; i<self._sounds.length; i++) {
            if (!self._sounds[i]._paused) {
              return true;
            }
          }

          return false;
        },

        /**
         * Get the duration of this sound. Passing a sound id will return the sprite duration.
         * @param  {Number} id The sound id to check. If none is passed, return full source duration.
         * @return {Number} Audio duration in seconds.
         */
        duration: function(id) {
          var self = this;
          var duration = self._duration;

          // If we pass an ID, get the sound and return the sprite length.
          var sound = self._soundById(id);
          if (sound) {
            duration = self._sprite[sound._sprite][1] / 1000;
          }

          return duration;
        },

        /**
         * Returns the current loaded state of this Howl.
         * @return {String} 'unloaded', 'loading', 'loaded'
         */
        state: function() {
          return this._state;
        },

        /**
         * Unload and destroy the current Howl object.
         * This will immediately stop all sound instances attached to this group.
         */
        unload: function() {
          var self = this;

          // Stop playing any active sounds.
          var sounds = self._sounds;
          for (var i=0; i<sounds.length; i++) {
            // Stop the sound if it is currently playing.
            if (!sounds[i]._paused) {
              self.stop(sounds[i]._id);
            }

            // Remove the source or disconnect.
            if (!self._webAudio) {
              // Set the source to 0-second silence to stop any downloading (except in IE).
              self._clearSound(sounds[i]._node);

              // Remove any event listeners.
              sounds[i]._node.removeEventListener('error', sounds[i]._errorFn, false);
              sounds[i]._node.removeEventListener(Howler._canPlayEvent, sounds[i]._loadFn, false);

              // Release the Audio object back to the pool.
              Howler._releaseHtml5Audio(sounds[i]._node);
            }

            // Empty out all of the nodes.
            delete sounds[i]._node;

            // Make sure all timers are cleared out.
            self._clearTimer(sounds[i]._id);
          }

          // Remove the references in the global Howler object.
          var index = Howler._howls.indexOf(self);
          if (index >= 0) {
            Howler._howls.splice(index, 1);
          }

          // Delete this sound from the cache (if no other Howl is using it).
          var remCache = true;
          for (i=0; i<Howler._howls.length; i++) {
            if (Howler._howls[i]._src === self._src || self._src.indexOf(Howler._howls[i]._src) >= 0) {
              remCache = false;
              break;
            }
          }

          if (cache && remCache) {
            delete cache[self._src];
          }

          // Clear global errors.
          Howler.noAudio = false;

          // Clear out `self`.
          self._state = 'unloaded';
          self._sounds = [];
          self = null;

          return null;
        },

        /**
         * Listen to a custom event.
         * @param  {String}   event Event name.
         * @param  {Function} fn    Listener to call.
         * @param  {Number}   id    (optional) Only listen to events for this sound.
         * @param  {Number}   once  (INTERNAL) Marks event to fire only once.
         * @return {Howl}
         */
        on: function(event, fn, id, once) {
          var self = this;
          var events = self['_on' + event];

          if (typeof fn === 'function') {
            events.push(once ? {id: id, fn: fn, once: once} : {id: id, fn: fn});
          }

          return self;
        },

        /**
         * Remove a custom event. Call without parameters to remove all events.
         * @param  {String}   event Event name.
         * @param  {Function} fn    Listener to remove. Leave empty to remove all.
         * @param  {Number}   id    (optional) Only remove events for this sound.
         * @return {Howl}
         */
        off: function(event, fn, id) {
          var self = this;
          var events = self['_on' + event];
          var i = 0;

          // Allow passing just an event and ID.
          if (typeof fn === 'number') {
            id = fn;
            fn = null;
          }

          if (fn || id) {
            // Loop through event store and remove the passed function.
            for (i=0; i<events.length; i++) {
              var isId = (id === events[i].id);
              if (fn === events[i].fn && isId || !fn && isId) {
                events.splice(i, 1);
                break;
              }
            }
          } else if (event) {
            // Clear out all events of this type.
            self['_on' + event] = [];
          } else {
            // Clear out all events of every type.
            var keys = Object.keys(self);
            for (i=0; i<keys.length; i++) {
              if ((keys[i].indexOf('_on') === 0) && Array.isArray(self[keys[i]])) {
                self[keys[i]] = [];
              }
            }
          }

          return self;
        },

        /**
         * Listen to a custom event and remove it once fired.
         * @param  {String}   event Event name.
         * @param  {Function} fn    Listener to call.
         * @param  {Number}   id    (optional) Only listen to events for this sound.
         * @return {Howl}
         */
        once: function(event, fn, id) {
          var self = this;

          // Setup the event listener.
          self.on(event, fn, id, 1);

          return self;
        },

        /**
         * Emit all events of a specific type and pass the sound id.
         * @param  {String} event Event name.
         * @param  {Number} id    Sound ID.
         * @param  {Number} msg   Message to go with event.
         * @return {Howl}
         */
        _emit: function(event, id, msg) {
          var self = this;
          var events = self['_on' + event];

          // Loop through event store and fire all functions.
          for (var i=events.length-1; i>=0; i--) {
            // Only fire the listener if the correct ID is used.
            if (!events[i].id || events[i].id === id || event === 'load') {
              setTimeout(function(fn) {
                fn.call(this, id, msg);
              }.bind(self, events[i].fn), 0);

              // If this event was setup with `once`, remove it.
              if (events[i].once) {
                self.off(event, events[i].fn, events[i].id);
              }
            }
          }

          // Pass the event type into load queue so that it can continue stepping.
          self._loadQueue(event);

          return self;
        },

        /**
         * Queue of actions initiated before the sound has loaded.
         * These will be called in sequence, with the next only firing
         * after the previous has finished executing (even if async like play).
         * @return {Howl}
         */
        _loadQueue: function(event) {
          var self = this;

          if (self._queue.length > 0) {
            var task = self._queue[0];

            // Remove this task if a matching event was passed.
            if (task.event === event) {
              self._queue.shift();
              self._loadQueue();
            }

            // Run the task if no event type is passed.
            if (!event) {
              task.action();
            }
          }

          return self;
        },

        /**
         * Fired when playback ends at the end of the duration.
         * @param  {Sound} sound The sound object to work with.
         * @return {Howl}
         */
        _ended: function(sound) {
          var self = this;
          var sprite = sound._sprite;

          // If we are using IE and there was network latency we may be clipping
          // audio before it completes playing. Lets check the node to make sure it
          // believes it has completed, before ending the playback.
          if (!self._webAudio && sound._node && !sound._node.paused && !sound._node.ended && sound._node.currentTime < sound._stop) {
            setTimeout(self._ended.bind(self, sound), 100);
            return self;
          }

          // Should this sound loop?
          var loop = !!(sound._loop || self._sprite[sprite][2]);

          // Fire the ended event.
          self._emit('end', sound._id);

          // Restart the playback for HTML5 Audio loop.
          if (!self._webAudio && loop) {
            self.stop(sound._id, true).play(sound._id);
          }

          // Restart this timer if on a Web Audio loop.
          if (self._webAudio && loop) {
            self._emit('play', sound._id);
            sound._seek = sound._start || 0;
            sound._rateSeek = 0;
            sound._playStart = Howler.ctx.currentTime;

            var timeout = ((sound._stop - sound._start) * 1000) / Math.abs(sound._rate);
            self._endTimers[sound._id] = setTimeout(self._ended.bind(self, sound), timeout);
          }

          // Mark the node as paused.
          if (self._webAudio && !loop) {
            sound._paused = true;
            sound._ended = true;
            sound._seek = sound._start || 0;
            sound._rateSeek = 0;
            self._clearTimer(sound._id);

            // Clean up the buffer source.
            self._cleanBuffer(sound._node);

            // Attempt to auto-suspend AudioContext if no sounds are still playing.
            Howler._autoSuspend();
          }

          // When using a sprite, end the track.
          if (!self._webAudio && !loop) {
            self.stop(sound._id, true);
          }

          return self;
        },

        /**
         * Clear the end timer for a sound playback.
         * @param  {Number} id The sound ID.
         * @return {Howl}
         */
        _clearTimer: function(id) {
          var self = this;

          if (self._endTimers[id]) {
            // Clear the timeout or remove the ended listener.
            if (typeof self._endTimers[id] !== 'function') {
              clearTimeout(self._endTimers[id]);
            } else {
              var sound = self._soundById(id);
              if (sound && sound._node) {
                sound._node.removeEventListener('ended', self._endTimers[id], false);
              }
            }

            delete self._endTimers[id];
          }

          return self;
        },

        /**
         * Return the sound identified by this ID, or return null.
         * @param  {Number} id Sound ID
         * @return {Object}    Sound object or null.
         */
        _soundById: function(id) {
          var self = this;

          // Loop through all sounds and find the one with this ID.
          for (var i=0; i<self._sounds.length; i++) {
            if (id === self._sounds[i]._id) {
              return self._sounds[i];
            }
          }

          return null;
        },

        /**
         * Return an inactive sound from the pool or create a new one.
         * @return {Sound} Sound playback object.
         */
        _inactiveSound: function() {
          var self = this;

          self._drain();

          // Find the first inactive node to recycle.
          for (var i=0; i<self._sounds.length; i++) {
            if (self._sounds[i]._ended) {
              return self._sounds[i].reset();
            }
          }

          // If no inactive node was found, create a new one.
          return new Sound(self);
        },

        /**
         * Drain excess inactive sounds from the pool.
         */
        _drain: function() {
          var self = this;
          var limit = self._pool;
          var cnt = 0;
          var i = 0;

          // If there are less sounds than the max pool size, we are done.
          if (self._sounds.length < limit) {
            return;
          }

          // Count the number of inactive sounds.
          for (i=0; i<self._sounds.length; i++) {
            if (self._sounds[i]._ended) {
              cnt++;
            }
          }

          // Remove excess inactive sounds, going in reverse order.
          for (i=self._sounds.length - 1; i>=0; i--) {
            if (cnt <= limit) {
              return;
            }

            if (self._sounds[i]._ended) {
              // Disconnect the audio source when using Web Audio.
              if (self._webAudio && self._sounds[i]._node) {
                self._sounds[i]._node.disconnect(0);
              }

              // Remove sounds until we have the pool size.
              self._sounds.splice(i, 1);
              cnt--;
            }
          }
        },

        /**
         * Get all ID's from the sounds pool.
         * @param  {Number} id Only return one ID if one is passed.
         * @return {Array}    Array of IDs.
         */
        _getSoundIds: function(id) {
          var self = this;

          if (typeof id === 'undefined') {
            var ids = [];
            for (var i=0; i<self._sounds.length; i++) {
              ids.push(self._sounds[i]._id);
            }

            return ids;
          } else {
            return [id];
          }
        },

        /**
         * Load the sound back into the buffer source.
         * @param  {Sound} sound The sound object to work with.
         * @return {Howl}
         */
        _refreshBuffer: function(sound) {
          var self = this;

          // Setup the buffer source for playback.
          sound._node.bufferSource = Howler.ctx.createBufferSource();
          sound._node.bufferSource.buffer = cache[self._src];

          // Connect to the correct node.
          if (sound._panner) {
            sound._node.bufferSource.connect(sound._panner);
          } else {
            sound._node.bufferSource.connect(sound._node);
          }

          // Setup looping and playback rate.
          sound._node.bufferSource.loop = sound._loop;
          if (sound._loop) {
            sound._node.bufferSource.loopStart = sound._start || 0;
            sound._node.bufferSource.loopEnd = sound._stop || 0;
          }
          sound._node.bufferSource.playbackRate.setValueAtTime(sound._rate, Howler.ctx.currentTime);

          return self;
        },

        /**
         * Prevent memory leaks by cleaning up the buffer source after playback.
         * @param  {Object} node Sound's audio node containing the buffer source.
         * @return {Howl}
         */
        _cleanBuffer: function(node) {
          var self = this;
          var isIOS = Howler._navigator && Howler._navigator.vendor.indexOf('Apple') >= 0;

          if (Howler._scratchBuffer && node.bufferSource) {
            node.bufferSource.onended = null;
            node.bufferSource.disconnect(0);
            if (isIOS) {
              try { node.bufferSource.buffer = Howler._scratchBuffer; } catch(e) {}
            }
          }
          node.bufferSource = null;

          return self;
        },

        /**
         * Set the source to a 0-second silence to stop any downloading (except in IE).
         * @param  {Object} node Audio node to clear.
         */
        _clearSound: function(node) {
          var checkIE = /MSIE |Trident\//.test(Howler._navigator && Howler._navigator.userAgent);
          if (!checkIE) {
            node.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
          }
        }
      };

      /** Single Sound Methods **/
      /***************************************************************************/

      /**
       * Setup the sound object, which each node attached to a Howl group is contained in.
       * @param {Object} howl The Howl parent group.
       */
      var Sound = function(howl) {
        this._parent = howl;
        this.init();
      };
      Sound.prototype = {
        /**
         * Initialize a new Sound object.
         * @return {Sound}
         */
        init: function() {
          var self = this;
          var parent = self._parent;

          // Setup the default parameters.
          self._muted = parent._muted;
          self._loop = parent._loop;
          self._volume = parent._volume;
          self._rate = parent._rate;
          self._seek = 0;
          self._paused = true;
          self._ended = true;
          self._sprite = '__default';

          // Generate a unique ID for this sound.
          self._id = ++Howler._counter;

          // Add itself to the parent's pool.
          parent._sounds.push(self);

          // Create the new node.
          self.create();

          return self;
        },

        /**
         * Create and setup a new sound object, whether HTML5 Audio or Web Audio.
         * @return {Sound}
         */
        create: function() {
          var self = this;
          var parent = self._parent;
          var volume = (Howler._muted || self._muted || self._parent._muted) ? 0 : self._volume;

          if (parent._webAudio) {
            // Create the gain node for controlling volume (the source will connect to this).
            self._node = (typeof Howler.ctx.createGain === 'undefined') ? Howler.ctx.createGainNode() : Howler.ctx.createGain();
            self._node.gain.setValueAtTime(volume, Howler.ctx.currentTime);
            self._node.paused = true;
            self._node.connect(Howler.masterGain);
          } else {
            // Get an unlocked Audio object from the pool.
            self._node = Howler._obtainHtml5Audio();

            // Listen for errors (http://dev.w3.org/html5/spec-author-view/spec.html#mediaerror).
            self._errorFn = self._errorListener.bind(self);
            self._node.addEventListener('error', self._errorFn, false);

            // Listen for 'canplaythrough' event to let us know the sound is ready.
            self._loadFn = self._loadListener.bind(self);
            self._node.addEventListener(Howler._canPlayEvent, self._loadFn, false);

            // Setup the new audio node.
            self._node.src = parent._src;
            self._node.preload = 'auto';
            self._node.volume = volume * Howler.volume();

            // Begin loading the source.
            self._node.load();
          }

          return self;
        },

        /**
         * Reset the parameters of this sound to the original state (for recycle).
         * @return {Sound}
         */
        reset: function() {
          var self = this;
          var parent = self._parent;

          // Reset all of the parameters of this sound.
          self._muted = parent._muted;
          self._loop = parent._loop;
          self._volume = parent._volume;
          self._rate = parent._rate;
          self._seek = 0;
          self._rateSeek = 0;
          self._paused = true;
          self._ended = true;
          self._sprite = '__default';

          // Generate a new ID so that it isn't confused with the previous sound.
          self._id = ++Howler._counter;

          return self;
        },

        /**
         * HTML5 Audio error listener callback.
         */
        _errorListener: function() {
          var self = this;

          // Fire an error event and pass back the code.
          self._parent._emit('loaderror', self._id, self._node.error ? self._node.error.code : 0);

          // Clear the event listener.
          self._node.removeEventListener('error', self._errorFn, false);
        },

        /**
         * HTML5 Audio canplaythrough listener callback.
         */
        _loadListener: function() {
          var self = this;
          var parent = self._parent;

          // Round up the duration to account for the lower precision in HTML5 Audio.
          parent._duration = Math.ceil(self._node.duration * 10) / 10;

          // Setup a sprite if none is defined.
          if (Object.keys(parent._sprite).length === 0) {
            parent._sprite = {__default: [0, parent._duration * 1000]};
          }

          if (parent._state !== 'loaded') {
            parent._state = 'loaded';
            parent._emit('load');
            parent._loadQueue();
          }

          // Clear the event listener.
          self._node.removeEventListener(Howler._canPlayEvent, self._loadFn, false);
        }
      };

      /** Helper Methods **/
      /***************************************************************************/

      var cache = {};

      /**
       * Buffer a sound from URL, Data URI or cache and decode to audio source (Web Audio API).
       * @param  {Howl} self
       */
      var loadBuffer = function(self) {
        var url = self._src;

        // Check if the buffer has already been cached and use it instead.
        if (cache[url]) {
          // Set the duration from the cache.
          self._duration = cache[url].duration;

          // Load the sound into this Howl.
          loadSound(self);

          return;
        }

        if (/^data:[^;]+;base64,/.test(url)) {
          // Decode the base64 data URI without XHR, since some browsers don't support it.
          var data = atob(url.split(',')[1]);
          var dataView = new Uint8Array(data.length);
          for (var i=0; i<data.length; ++i) {
            dataView[i] = data.charCodeAt(i);
          }

          decodeAudioData(dataView.buffer, self);
        } else {
          // Load the buffer from the URL.
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.withCredentials = self._xhrWithCredentials;
          xhr.responseType = 'arraybuffer';
          xhr.onload = function() {
            // Make sure we get a successful response back.
            var code = (xhr.status + '')[0];
            if (code !== '0' && code !== '2' && code !== '3') {
              self._emit('loaderror', null, 'Failed loading audio file with status: ' + xhr.status + '.');
              return;
            }

            decodeAudioData(xhr.response, self);
          };
          xhr.onerror = function() {
            // If there is an error, switch to HTML5 Audio.
            if (self._webAudio) {
              self._html5 = true;
              self._webAudio = false;
              self._sounds = [];
              delete cache[url];
              self.load();
            }
          };
          safeXhrSend(xhr);
        }
      };

      /**
       * Send the XHR request wrapped in a try/catch.
       * @param  {Object} xhr XHR to send.
       */
      var safeXhrSend = function(xhr) {
        try {
          xhr.send();
        } catch (e) {
          xhr.onerror();
        }
      };

      /**
       * Decode audio data from an array buffer.
       * @param  {ArrayBuffer} arraybuffer The audio data.
       * @param  {Howl}        self
       */
      var decodeAudioData = function(arraybuffer, self) {
        // Fire a load error if something broke.
        var error = function() {
          self._emit('loaderror', null, 'Decoding audio data failed.');
        };

        // Load the sound on success.
        var success = function(buffer) {
          if (buffer && self._sounds.length > 0) {
            cache[self._src] = buffer;
            loadSound(self, buffer);
          } else {
            error();
          }
        };

        // Decode the buffer into an audio source.
        if (typeof Promise !== 'undefined' && Howler.ctx.decodeAudioData.length === 1) {
          Howler.ctx.decodeAudioData(arraybuffer).then(success).catch(error);
        } else {
          Howler.ctx.decodeAudioData(arraybuffer, success, error);
        }
      };

      /**
       * Sound is now loaded, so finish setting everything up and fire the loaded event.
       * @param  {Howl} self
       * @param  {Object} buffer The decoded buffer sound source.
       */
      var loadSound = function(self, buffer) {
        // Set the duration.
        if (buffer && !self._duration) {
          self._duration = buffer.duration;
        }

        // Setup a sprite if none is defined.
        if (Object.keys(self._sprite).length === 0) {
          self._sprite = {__default: [0, self._duration * 1000]};
        }

        // Fire the loaded event.
        if (self._state !== 'loaded') {
          self._state = 'loaded';
          self._emit('load');
          self._loadQueue();
        }
      };

      /**
       * Setup the audio context when available, or switch to HTML5 Audio mode.
       */
      var setupAudioContext = function() {
        // If we have already detected that Web Audio isn't supported, don't run this step again.
        if (!Howler.usingWebAudio) {
          return;
        }

        // Check if we are using Web Audio and setup the AudioContext if we are.
        try {
          if (typeof AudioContext !== 'undefined') {
            Howler.ctx = new AudioContext();
          } else if (typeof webkitAudioContext !== 'undefined') {
            Howler.ctx = new webkitAudioContext();
          } else {
            Howler.usingWebAudio = false;
          }
        } catch(e) {
          Howler.usingWebAudio = false;
        }

        // If the audio context creation still failed, set using web audio to false.
        if (!Howler.ctx) {
          Howler.usingWebAudio = false;
        }

        // Check if a webview is being used on iOS8 or earlier (rather than the browser).
        // If it is, disable Web Audio as it causes crashing.
        var iOS = (/iP(hone|od|ad)/.test(Howler._navigator && Howler._navigator.platform));
        var appVersion = Howler._navigator && Howler._navigator.appVersion.match(/OS (\d+)_(\d+)_?(\d+)?/);
        var version = appVersion ? parseInt(appVersion[1], 10) : null;
        if (iOS && version && version < 9) {
          var safari = /safari/.test(Howler._navigator && Howler._navigator.userAgent.toLowerCase());
          if (Howler._navigator && Howler._navigator.standalone && !safari || Howler._navigator && !Howler._navigator.standalone && !safari) {
            Howler.usingWebAudio = false;
          }
        }

        // Create and expose the master GainNode when using Web Audio (useful for plugins or advanced usage).
        if (Howler.usingWebAudio) {
          Howler.masterGain = (typeof Howler.ctx.createGain === 'undefined') ? Howler.ctx.createGainNode() : Howler.ctx.createGain();
          Howler.masterGain.gain.setValueAtTime(Howler._muted ? 0 : 1, Howler.ctx.currentTime);
          Howler.masterGain.connect(Howler.ctx.destination);
        }

        // Re-run the setup on Howler.
        Howler._setup();
      };

      // Add support for CommonJS libraries such as browserify.
      {
        exports.Howler = Howler;
        exports.Howl = Howl;
      }

      // Define globally in case AMD is not available or unused.
      if (typeof window !== 'undefined') {
        window.HowlerGlobal = HowlerGlobal;
        window.Howler = Howler;
        window.Howl = Howl;
        window.Sound = Sound;
      } else if (typeof commonjsGlobal !== 'undefined') { // Add to global in Node.js (for testing, etc).
        commonjsGlobal.HowlerGlobal = HowlerGlobal;
        commonjsGlobal.Howler = Howler;
        commonjsGlobal.Howl = Howl;
        commonjsGlobal.Sound = Sound;
      }
    })();


    /*!
     *  Spatial Plugin - Adds support for stereo and 3D audio where Web Audio is supported.
     *  
     *  howler.js v2.1.2
     *  howlerjs.com
     *
     *  (c) 2013-2019, James Simpson of GoldFire Studios
     *  goldfirestudios.com
     *
     *  MIT License
     */

    (function() {

      // Setup default properties.
      HowlerGlobal.prototype._pos = [0, 0, 0];
      HowlerGlobal.prototype._orientation = [0, 0, -1, 0, 1, 0];

      /** Global Methods **/
      /***************************************************************************/

      /**
       * Helper method to update the stereo panning position of all current Howls.
       * Future Howls will not use this value unless explicitly set.
       * @param  {Number} pan A value of -1.0 is all the way left and 1.0 is all the way right.
       * @return {Howler/Number}     Self or current stereo panning value.
       */
      HowlerGlobal.prototype.stereo = function(pan) {
        var self = this;

        // Stop right here if not using Web Audio.
        if (!self.ctx || !self.ctx.listener) {
          return self;
        }

        // Loop through all Howls and update their stereo panning.
        for (var i=self._howls.length-1; i>=0; i--) {
          self._howls[i].stereo(pan);
        }

        return self;
      };

      /**
       * Get/set the position of the listener in 3D cartesian space. Sounds using
       * 3D position will be relative to the listener's position.
       * @param  {Number} x The x-position of the listener.
       * @param  {Number} y The y-position of the listener.
       * @param  {Number} z The z-position of the listener.
       * @return {Howler/Array}   Self or current listener position.
       */
      HowlerGlobal.prototype.pos = function(x, y, z) {
        var self = this;

        // Stop right here if not using Web Audio.
        if (!self.ctx || !self.ctx.listener) {
          return self;
        }

        // Set the defaults for optional 'y' & 'z'.
        y = (typeof y !== 'number') ? self._pos[1] : y;
        z = (typeof z !== 'number') ? self._pos[2] : z;

        if (typeof x === 'number') {
          self._pos = [x, y, z];

          if (typeof self.ctx.listener.positionX !== 'undefined') {
            self.ctx.listener.positionX.setTargetAtTime(self._pos[0], Howler.ctx.currentTime, 0.1);
            self.ctx.listener.positionY.setTargetAtTime(self._pos[1], Howler.ctx.currentTime, 0.1);
            self.ctx.listener.positionZ.setTargetAtTime(self._pos[2], Howler.ctx.currentTime, 0.1);
          } else {
            self.ctx.listener.setPosition(self._pos[0], self._pos[1], self._pos[2]);
          }
        } else {
          return self._pos;
        }

        return self;
      };

      /**
       * Get/set the direction the listener is pointing in the 3D cartesian space.
       * A front and up vector must be provided. The front is the direction the
       * face of the listener is pointing, and up is the direction the top of the
       * listener is pointing. Thus, these values are expected to be at right angles
       * from each other.
       * @param  {Number} x   The x-orientation of the listener.
       * @param  {Number} y   The y-orientation of the listener.
       * @param  {Number} z   The z-orientation of the listener.
       * @param  {Number} xUp The x-orientation of the top of the listener.
       * @param  {Number} yUp The y-orientation of the top of the listener.
       * @param  {Number} zUp The z-orientation of the top of the listener.
       * @return {Howler/Array}     Returns self or the current orientation vectors.
       */
      HowlerGlobal.prototype.orientation = function(x, y, z, xUp, yUp, zUp) {
        var self = this;

        // Stop right here if not using Web Audio.
        if (!self.ctx || !self.ctx.listener) {
          return self;
        }

        // Set the defaults for optional 'y' & 'z'.
        var or = self._orientation;
        y = (typeof y !== 'number') ? or[1] : y;
        z = (typeof z !== 'number') ? or[2] : z;
        xUp = (typeof xUp !== 'number') ? or[3] : xUp;
        yUp = (typeof yUp !== 'number') ? or[4] : yUp;
        zUp = (typeof zUp !== 'number') ? or[5] : zUp;

        if (typeof x === 'number') {
          self._orientation = [x, y, z, xUp, yUp, zUp];

          if (typeof self.ctx.listener.forwardX !== 'undefined') {
            self.ctx.listener.forwardX.setTargetAtTime(x, Howler.ctx.currentTime, 0.1);
            self.ctx.listener.forwardY.setTargetAtTime(y, Howler.ctx.currentTime, 0.1);
            self.ctx.listener.forwardZ.setTargetAtTime(z, Howler.ctx.currentTime, 0.1);
            self.ctx.listener.upX.setTargetAtTime(x, Howler.ctx.currentTime, 0.1);
            self.ctx.listener.upY.setTargetAtTime(y, Howler.ctx.currentTime, 0.1);
            self.ctx.listener.upZ.setTargetAtTime(z, Howler.ctx.currentTime, 0.1);
          } else {
            self.ctx.listener.setOrientation(x, y, z, xUp, yUp, zUp);
          }
        } else {
          return or;
        }

        return self;
      };

      /** Group Methods **/
      /***************************************************************************/

      /**
       * Add new properties to the core init.
       * @param  {Function} _super Core init method.
       * @return {Howl}
       */
      Howl.prototype.init = (function(_super) {
        return function(o) {
          var self = this;

          // Setup user-defined default properties.
          self._orientation = o.orientation || [1, 0, 0];
          self._stereo = o.stereo || null;
          self._pos = o.pos || null;
          self._pannerAttr = {
            coneInnerAngle: typeof o.coneInnerAngle !== 'undefined' ? o.coneInnerAngle : 360,
            coneOuterAngle: typeof o.coneOuterAngle !== 'undefined' ? o.coneOuterAngle : 360,
            coneOuterGain: typeof o.coneOuterGain !== 'undefined' ? o.coneOuterGain : 0,
            distanceModel: typeof o.distanceModel !== 'undefined' ? o.distanceModel : 'inverse',
            maxDistance: typeof o.maxDistance !== 'undefined' ? o.maxDistance : 10000,
            panningModel: typeof o.panningModel !== 'undefined' ? o.panningModel : 'HRTF',
            refDistance: typeof o.refDistance !== 'undefined' ? o.refDistance : 1,
            rolloffFactor: typeof o.rolloffFactor !== 'undefined' ? o.rolloffFactor : 1
          };

          // Setup event listeners.
          self._onstereo = o.onstereo ? [{fn: o.onstereo}] : [];
          self._onpos = o.onpos ? [{fn: o.onpos}] : [];
          self._onorientation = o.onorientation ? [{fn: o.onorientation}] : [];

          // Complete initilization with howler.js core's init function.
          return _super.call(this, o);
        };
      })(Howl.prototype.init);

      /**
       * Get/set the stereo panning of the audio source for this sound or all in the group.
       * @param  {Number} pan  A value of -1.0 is all the way left and 1.0 is all the way right.
       * @param  {Number} id (optional) The sound ID. If none is passed, all in group will be updated.
       * @return {Howl/Number}    Returns self or the current stereo panning value.
       */
      Howl.prototype.stereo = function(pan, id) {
        var self = this;

        // Stop right here if not using Web Audio.
        if (!self._webAudio) {
          return self;
        }

        // If the sound hasn't loaded, add it to the load queue to change stereo pan when capable.
        if (self._state !== 'loaded') {
          self._queue.push({
            event: 'stereo',
            action: function() {
              self.stereo(pan, id);
            }
          });

          return self;
        }

        // Check for PannerStereoNode support and fallback to PannerNode if it doesn't exist.
        var pannerType = (typeof Howler.ctx.createStereoPanner === 'undefined') ? 'spatial' : 'stereo';

        // Setup the group's stereo panning if no ID is passed.
        if (typeof id === 'undefined') {
          // Return the group's stereo panning if no parameters are passed.
          if (typeof pan === 'number') {
            self._stereo = pan;
            self._pos = [pan, 0, 0];
          } else {
            return self._stereo;
          }
        }

        // Change the streo panning of one or all sounds in group.
        var ids = self._getSoundIds(id);
        for (var i=0; i<ids.length; i++) {
          // Get the sound.
          var sound = self._soundById(ids[i]);

          if (sound) {
            if (typeof pan === 'number') {
              sound._stereo = pan;
              sound._pos = [pan, 0, 0];

              if (sound._node) {
                // If we are falling back, make sure the panningModel is equalpower.
                sound._pannerAttr.panningModel = 'equalpower';

                // Check if there is a panner setup and create a new one if not.
                if (!sound._panner || !sound._panner.pan) {
                  setupPanner(sound, pannerType);
                }

                if (pannerType === 'spatial') {
                  if (typeof sound._panner.positionX !== 'undefined') {
                    sound._panner.positionX.setValueAtTime(pan, Howler.ctx.currentTime);
                    sound._panner.positionY.setValueAtTime(0, Howler.ctx.currentTime);
                    sound._panner.positionZ.setValueAtTime(0, Howler.ctx.currentTime);
                  } else {
                    sound._panner.setPosition(pan, 0, 0);
                  }
                } else {
                  sound._panner.pan.setValueAtTime(pan, Howler.ctx.currentTime);
                }
              }

              self._emit('stereo', sound._id);
            } else {
              return sound._stereo;
            }
          }
        }

        return self;
      };

      /**
       * Get/set the 3D spatial position of the audio source for this sound or group relative to the global listener.
       * @param  {Number} x  The x-position of the audio source.
       * @param  {Number} y  The y-position of the audio source.
       * @param  {Number} z  The z-position of the audio source.
       * @param  {Number} id (optional) The sound ID. If none is passed, all in group will be updated.
       * @return {Howl/Array}    Returns self or the current 3D spatial position: [x, y, z].
       */
      Howl.prototype.pos = function(x, y, z, id) {
        var self = this;

        // Stop right here if not using Web Audio.
        if (!self._webAudio) {
          return self;
        }

        // If the sound hasn't loaded, add it to the load queue to change position when capable.
        if (self._state !== 'loaded') {
          self._queue.push({
            event: 'pos',
            action: function() {
              self.pos(x, y, z, id);
            }
          });

          return self;
        }

        // Set the defaults for optional 'y' & 'z'.
        y = (typeof y !== 'number') ? 0 : y;
        z = (typeof z !== 'number') ? -0.5 : z;

        // Setup the group's spatial position if no ID is passed.
        if (typeof id === 'undefined') {
          // Return the group's spatial position if no parameters are passed.
          if (typeof x === 'number') {
            self._pos = [x, y, z];
          } else {
            return self._pos;
          }
        }

        // Change the spatial position of one or all sounds in group.
        var ids = self._getSoundIds(id);
        for (var i=0; i<ids.length; i++) {
          // Get the sound.
          var sound = self._soundById(ids[i]);

          if (sound) {
            if (typeof x === 'number') {
              sound._pos = [x, y, z];

              if (sound._node) {
                // Check if there is a panner setup and create a new one if not.
                if (!sound._panner || sound._panner.pan) {
                  setupPanner(sound, 'spatial');
                }

                if (typeof sound._panner.positionX !== 'undefined') {
                  sound._panner.positionX.setValueAtTime(x, Howler.ctx.currentTime);
                  sound._panner.positionY.setValueAtTime(y, Howler.ctx.currentTime);
                  sound._panner.positionZ.setValueAtTime(z, Howler.ctx.currentTime);
                } else {
                  sound._panner.setPosition(x, y, z);
                }
              }

              self._emit('pos', sound._id);
            } else {
              return sound._pos;
            }
          }
        }

        return self;
      };

      /**
       * Get/set the direction the audio source is pointing in the 3D cartesian coordinate
       * space. Depending on how direction the sound is, based on the `cone` attributes,
       * a sound pointing away from the listener can be quiet or silent.
       * @param  {Number} x  The x-orientation of the source.
       * @param  {Number} y  The y-orientation of the source.
       * @param  {Number} z  The z-orientation of the source.
       * @param  {Number} id (optional) The sound ID. If none is passed, all in group will be updated.
       * @return {Howl/Array}    Returns self or the current 3D spatial orientation: [x, y, z].
       */
      Howl.prototype.orientation = function(x, y, z, id) {
        var self = this;

        // Stop right here if not using Web Audio.
        if (!self._webAudio) {
          return self;
        }

        // If the sound hasn't loaded, add it to the load queue to change orientation when capable.
        if (self._state !== 'loaded') {
          self._queue.push({
            event: 'orientation',
            action: function() {
              self.orientation(x, y, z, id);
            }
          });

          return self;
        }

        // Set the defaults for optional 'y' & 'z'.
        y = (typeof y !== 'number') ? self._orientation[1] : y;
        z = (typeof z !== 'number') ? self._orientation[2] : z;

        // Setup the group's spatial orientation if no ID is passed.
        if (typeof id === 'undefined') {
          // Return the group's spatial orientation if no parameters are passed.
          if (typeof x === 'number') {
            self._orientation = [x, y, z];
          } else {
            return self._orientation;
          }
        }

        // Change the spatial orientation of one or all sounds in group.
        var ids = self._getSoundIds(id);
        for (var i=0; i<ids.length; i++) {
          // Get the sound.
          var sound = self._soundById(ids[i]);

          if (sound) {
            if (typeof x === 'number') {
              sound._orientation = [x, y, z];

              if (sound._node) {
                // Check if there is a panner setup and create a new one if not.
                if (!sound._panner) {
                  // Make sure we have a position to setup the node with.
                  if (!sound._pos) {
                    sound._pos = self._pos || [0, 0, -0.5];
                  }

                  setupPanner(sound, 'spatial');
                }

                if (typeof sound._panner.orientationX !== 'undefined') {
                  sound._panner.orientationX.setValueAtTime(x, Howler.ctx.currentTime);
                  sound._panner.orientationY.setValueAtTime(y, Howler.ctx.currentTime);
                  sound._panner.orientationZ.setValueAtTime(z, Howler.ctx.currentTime);
                } else {
                  sound._panner.setOrientation(x, y, z);
                }
              }

              self._emit('orientation', sound._id);
            } else {
              return sound._orientation;
            }
          }
        }

        return self;
      };

      /**
       * Get/set the panner node's attributes for a sound or group of sounds.
       * This method can optionall take 0, 1 or 2 arguments.
       *   pannerAttr() -> Returns the group's values.
       *   pannerAttr(id) -> Returns the sound id's values.
       *   pannerAttr(o) -> Set's the values of all sounds in this Howl group.
       *   pannerAttr(o, id) -> Set's the values of passed sound id.
       *
       *   Attributes:
       *     coneInnerAngle - (360 by default) A parameter for directional audio sources, this is an angle, in degrees,
       *                      inside of which there will be no volume reduction.
       *     coneOuterAngle - (360 by default) A parameter for directional audio sources, this is an angle, in degrees,
       *                      outside of which the volume will be reduced to a constant value of `coneOuterGain`.
       *     coneOuterGain - (0 by default) A parameter for directional audio sources, this is the gain outside of the
       *                     `coneOuterAngle`. It is a linear value in the range `[0, 1]`.
       *     distanceModel - ('inverse' by default) Determines algorithm used to reduce volume as audio moves away from
       *                     listener. Can be `linear`, `inverse` or `exponential.
       *     maxDistance - (10000 by default) The maximum distance between source and listener, after which the volume
       *                   will not be reduced any further.
       *     refDistance - (1 by default) A reference distance for reducing volume as source moves further from the listener.
       *                   This is simply a variable of the distance model and has a different effect depending on which model
       *                   is used and the scale of your coordinates. Generally, volume will be equal to 1 at this distance.
       *     rolloffFactor - (1 by default) How quickly the volume reduces as source moves from listener. This is simply a
       *                     variable of the distance model and can be in the range of `[0, 1]` with `linear` and `[0, ∞]`
       *                     with `inverse` and `exponential`.
       *     panningModel - ('HRTF' by default) Determines which spatialization algorithm is used to position audio.
       *                     Can be `HRTF` or `equalpower`.
       *
       * @return {Howl/Object} Returns self or current panner attributes.
       */
      Howl.prototype.pannerAttr = function() {
        var self = this;
        var args = arguments;
        var o, id, sound;

        // Stop right here if not using Web Audio.
        if (!self._webAudio) {
          return self;
        }

        // Determine the values based on arguments.
        if (args.length === 0) {
          // Return the group's panner attribute values.
          return self._pannerAttr;
        } else if (args.length === 1) {
          if (typeof args[0] === 'object') {
            o = args[0];

            // Set the grou's panner attribute values.
            if (typeof id === 'undefined') {
              if (!o.pannerAttr) {
                o.pannerAttr = {
                  coneInnerAngle: o.coneInnerAngle,
                  coneOuterAngle: o.coneOuterAngle,
                  coneOuterGain: o.coneOuterGain,
                  distanceModel: o.distanceModel,
                  maxDistance: o.maxDistance,
                  refDistance: o.refDistance,
                  rolloffFactor: o.rolloffFactor,
                  panningModel: o.panningModel
                };
              }

              self._pannerAttr = {
                coneInnerAngle: typeof o.pannerAttr.coneInnerAngle !== 'undefined' ? o.pannerAttr.coneInnerAngle : self._coneInnerAngle,
                coneOuterAngle: typeof o.pannerAttr.coneOuterAngle !== 'undefined' ? o.pannerAttr.coneOuterAngle : self._coneOuterAngle,
                coneOuterGain: typeof o.pannerAttr.coneOuterGain !== 'undefined' ? o.pannerAttr.coneOuterGain : self._coneOuterGain,
                distanceModel: typeof o.pannerAttr.distanceModel !== 'undefined' ? o.pannerAttr.distanceModel : self._distanceModel,
                maxDistance: typeof o.pannerAttr.maxDistance !== 'undefined' ? o.pannerAttr.maxDistance : self._maxDistance,
                refDistance: typeof o.pannerAttr.refDistance !== 'undefined' ? o.pannerAttr.refDistance : self._refDistance,
                rolloffFactor: typeof o.pannerAttr.rolloffFactor !== 'undefined' ? o.pannerAttr.rolloffFactor : self._rolloffFactor,
                panningModel: typeof o.pannerAttr.panningModel !== 'undefined' ? o.pannerAttr.panningModel : self._panningModel
              };
            }
          } else {
            // Return this sound's panner attribute values.
            sound = self._soundById(parseInt(args[0], 10));
            return sound ? sound._pannerAttr : self._pannerAttr;
          }
        } else if (args.length === 2) {
          o = args[0];
          id = parseInt(args[1], 10);
        }

        // Update the values of the specified sounds.
        var ids = self._getSoundIds(id);
        for (var i=0; i<ids.length; i++) {
          sound = self._soundById(ids[i]);

          if (sound) {
            // Merge the new values into the sound.
            var pa = sound._pannerAttr;
            pa = {
              coneInnerAngle: typeof o.coneInnerAngle !== 'undefined' ? o.coneInnerAngle : pa.coneInnerAngle,
              coneOuterAngle: typeof o.coneOuterAngle !== 'undefined' ? o.coneOuterAngle : pa.coneOuterAngle,
              coneOuterGain: typeof o.coneOuterGain !== 'undefined' ? o.coneOuterGain : pa.coneOuterGain,
              distanceModel: typeof o.distanceModel !== 'undefined' ? o.distanceModel : pa.distanceModel,
              maxDistance: typeof o.maxDistance !== 'undefined' ? o.maxDistance : pa.maxDistance,
              refDistance: typeof o.refDistance !== 'undefined' ? o.refDistance : pa.refDistance,
              rolloffFactor: typeof o.rolloffFactor !== 'undefined' ? o.rolloffFactor : pa.rolloffFactor,
              panningModel: typeof o.panningModel !== 'undefined' ? o.panningModel : pa.panningModel
            };

            // Update the panner values or create a new panner if none exists.
            var panner = sound._panner;
            if (panner) {
              panner.coneInnerAngle = pa.coneInnerAngle;
              panner.coneOuterAngle = pa.coneOuterAngle;
              panner.coneOuterGain = pa.coneOuterGain;
              panner.distanceModel = pa.distanceModel;
              panner.maxDistance = pa.maxDistance;
              panner.refDistance = pa.refDistance;
              panner.rolloffFactor = pa.rolloffFactor;
              panner.panningModel = pa.panningModel;
            } else {
              // Make sure we have a position to setup the node with.
              if (!sound._pos) {
                sound._pos = self._pos || [0, 0, -0.5];
              }

              // Create a new panner node.
              setupPanner(sound, 'spatial');
            }
          }
        }

        return self;
      };

      /** Single Sound Methods **/
      /***************************************************************************/

      /**
       * Add new properties to the core Sound init.
       * @param  {Function} _super Core Sound init method.
       * @return {Sound}
       */
      Sound.prototype.init = (function(_super) {
        return function() {
          var self = this;
          var parent = self._parent;

          // Setup user-defined default properties.
          self._orientation = parent._orientation;
          self._stereo = parent._stereo;
          self._pos = parent._pos;
          self._pannerAttr = parent._pannerAttr;

          // Complete initilization with howler.js core Sound's init function.
          _super.call(this);

          // If a stereo or position was specified, set it up.
          if (self._stereo) {
            parent.stereo(self._stereo);
          } else if (self._pos) {
            parent.pos(self._pos[0], self._pos[1], self._pos[2], self._id);
          }
        };
      })(Sound.prototype.init);

      /**
       * Override the Sound.reset method to clean up properties from the spatial plugin.
       * @param  {Function} _super Sound reset method.
       * @return {Sound}
       */
      Sound.prototype.reset = (function(_super) {
        return function() {
          var self = this;
          var parent = self._parent;

          // Reset all spatial plugin properties on this sound.
          self._orientation = parent._orientation;
          self._stereo = parent._stereo;
          self._pos = parent._pos;
          self._pannerAttr = parent._pannerAttr;

          // If a stereo or position was specified, set it up.
          if (self._stereo) {
            parent.stereo(self._stereo);
          } else if (self._pos) {
            parent.pos(self._pos[0], self._pos[1], self._pos[2], self._id);
          } else if (self._panner) {
            // Disconnect the panner.
            self._panner.disconnect(0);
            self._panner = undefined;
            parent._refreshBuffer(self);
          }

          // Complete resetting of the sound.
          return _super.call(this);
        };
      })(Sound.prototype.reset);

      /** Helper Methods **/
      /***************************************************************************/

      /**
       * Create a new panner node and save it on the sound.
       * @param  {Sound} sound Specific sound to setup panning on.
       * @param {String} type Type of panner to create: 'stereo' or 'spatial'.
       */
      var setupPanner = function(sound, type) {
        type = type || 'spatial';

        // Create the new panner node.
        if (type === 'spatial') {
          sound._panner = Howler.ctx.createPanner();
          sound._panner.coneInnerAngle = sound._pannerAttr.coneInnerAngle;
          sound._panner.coneOuterAngle = sound._pannerAttr.coneOuterAngle;
          sound._panner.coneOuterGain = sound._pannerAttr.coneOuterGain;
          sound._panner.distanceModel = sound._pannerAttr.distanceModel;
          sound._panner.maxDistance = sound._pannerAttr.maxDistance;
          sound._panner.refDistance = sound._pannerAttr.refDistance;
          sound._panner.rolloffFactor = sound._pannerAttr.rolloffFactor;
          sound._panner.panningModel = sound._pannerAttr.panningModel;

          if (typeof sound._panner.positionX !== 'undefined') {
            sound._panner.positionX.setValueAtTime(sound._pos[0], Howler.ctx.currentTime);
            sound._panner.positionY.setValueAtTime(sound._pos[1], Howler.ctx.currentTime);
            sound._panner.positionZ.setValueAtTime(sound._pos[2], Howler.ctx.currentTime);
          } else {
            sound._panner.setPosition(sound._pos[0], sound._pos[1], sound._pos[2]);
          }

          if (typeof sound._panner.orientationX !== 'undefined') {
            sound._panner.orientationX.setValueAtTime(sound._orientation[0], Howler.ctx.currentTime);
            sound._panner.orientationY.setValueAtTime(sound._orientation[1], Howler.ctx.currentTime);
            sound._panner.orientationZ.setValueAtTime(sound._orientation[2], Howler.ctx.currentTime);
          } else {
            sound._panner.setOrientation(sound._orientation[0], sound._orientation[1], sound._orientation[2]);
          }
        } else {
          sound._panner = Howler.ctx.createStereoPanner();
          sound._panner.pan.setValueAtTime(sound._stereo, Howler.ctx.currentTime);
        }

        sound._panner.connect(sound._node);

        // Update the connections.
        if (!sound._paused) {
          sound._parent.pause(sound._id, true).play(sound._id, true);
        }
      };
    })();
    });
    var howler_1 = howler.Howler;
    var howler_2 = howler.Howl;

    const AUDIO = {
      HOVER: "assets/audio/hover.mp3",
      CLICK: "assets/audio/selection.mp3"
    };

    const audio = source => new howler_2({
      src: [source]
    });

    const action = (event, sound) => node => {
      const handler = () => sound.play();

      node.addEventListener(event, handler);
      return () => node.removeEventListener(event, handler);
    };

    const click = action("click", audio(AUDIO.CLICK));
    const hover = action("mouseenter", audio(AUDIO.HOVER));

    /* src\components\icons\empty-icon.svelte generated by Svelte v3.12.1 */

    function add_css() {
    	var style = element("style");
    	style.id = 'svelte-ymmyl2-style';
    	style.textContent = ".svg.svelte-ymmyl2{margin:0 1rem;height:25%;width:25%}.path.svelte-ymmyl2{stroke-width:20;stroke:white}";
    	append(document.head, style);
    }

    function create_fragment(ctx) {
    	var svg, path;

    	return {
    		c() {
    			svg = svg_element("svg");
    			path = svg_element("path");
    			attr(path, "class", "path svelte-ymmyl2");
    			attr(path, "d", "M 0 50 L 100 50 M 50 0 L 50 100");
    			attr(svg, "class", "svg svelte-ymmyl2");
    			attr(svg, "viewBox", "0 0 100 100");
    		},

    		m(target, anchor) {
    			insert(target, svg, anchor);
    			append(svg, path);
    		},

    		p: noop,
    		i: noop,
    		o: noop,

    		d(detaching) {
    			if (detaching) {
    				detach(svg);
    			}
    		}
    	};
    }

    class Empty_icon extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-ymmyl2-style")) add_css();
    		init(this, options, null, create_fragment, safe_not_equal, []);
    	}
    }

    /* src\components\icons\style-icon.svelte generated by Svelte v3.12.1 */

    function create_fragment$1(ctx) {
    	var t_value = ctx.STYLES[ctx.style] + "", t;

    	return {
    		c() {
    			t = text(t_value);
    		},

    		m(target, anchor) {
    			insert(target, t, anchor);
    		},

    		p(changed, ctx) {
    			if ((changed.style) && t_value !== (t_value = ctx.STYLES[ctx.style] + "")) {
    				set_data(t, t_value);
    			}
    		},

    		i: noop,
    		o: noop,

    		d(detaching) {
    			if (detaching) {
    				detach(t);
    			}
    		}
    	};
    }

    function instance($$self, $$props, $$invalidate) {
    	const STYLES = {
            forsaken : "FSK",
            kahlt    : "KLT",
            windfall : "WND",
            stagger  : "STG",
            faejin   : "FAE",
            unknown  : "???",
        };

        let { style = "unknown" } = $$props;

    	$$self.$set = $$props => {
    		if ('style' in $$props) $$invalidate('style', style = $$props.style);
    	};

    	return { STYLES, style };
    }

    class Style_icon extends SvelteComponent {
    	constructor(options) {
    		super();
    		init(this, options, instance, create_fragment$1, safe_not_equal, ["style"]);
    	}
    }

    /* src\components\attack-tile.svelte generated by Svelte v3.12.1 */

    function add_css$1() {
    	var style = element("style");
    	style.id = 'svelte-1rcdrvh-style';
    	style.textContent = "@keyframes svelte-1rcdrvh-oscillate{0%{outline:0.15rem solid var(--color-gold)}50%{outline:0.15rem solid transparent}100%{outline:0.15rem solid var(--color-gold)}}.flex.svelte-1rcdrvh{display:flex;justify-content:center;align-items:center}.container.svelte-1rcdrvh{position:relative;height:var(--attack-tile-height, 8rem);width:var(--attack-tile-height, 8rem);background-color:rgba(0, 0, 0, 0.55);color:#FFF;background-size:contain;background-position:center;background-repeat:no-repeat;cursor:pointer;user-select:none}.container.svelte-1rcdrvh:hover,.container[data-current-target=\"true\"].svelte-1rcdrvh{animation-name:svelte-1rcdrvh-oscillate;animation-duration:1.5s;animation-iteration-count:infinite}.container[data-equipped=\"true\"].svelte-1rcdrvh::before{position:absolute;content:\"\";right:0;top:0;height:1rem;width:1rem;margin:0.15rem;padding:0.15rem;background-image:url(components/icons/equipped-icon.svg);background-color:var(--color-equipped-icon-background);border-radius:50%}.style.svelte-1rcdrvh{display:flex;flex-flow:row nowrap;width:100%;height:1rem;padding:0.2rem;position:absolute;top:0;font-size:0.6rem}.meta.svelte-1rcdrvh{display:flex;flex-flow:row nowrap;width:100%;height:1rem;padding:0.2rem;position:absolute;bottom:0;font-size:0.6rem}.meta-trait+.meta-trait.svelte-1rcdrvh{padding:0 0.2rem}";
    	append(document.head, style);
    }

    // (13:4) {:else}
    function create_else_block(ctx) {
    	var div0, t0, div1, show_if_5 = ctx.modifiers.includes("double"), t1, show_if_4 = ctx.modifiers.includes("break"), t2, show_if_3 = ctx.modifiers.includes("stop"), t3, show_if_2 = ctx.modifiers.includes("jump"), t4, show_if_1 = ctx.modifiers.includes("duck"), t5, show_if = ctx.modifiers.includes("strafe"), current;

    	var styleicon = new Style_icon({ props: { style: ctx.attack.style } });

    	var if_block0 = (show_if_5) && create_if_block_6();

    	var if_block1 = (show_if_4) && create_if_block_5();

    	var if_block2 = (show_if_3) && create_if_block_4();

    	var if_block3 = (show_if_2) && create_if_block_3();

    	var if_block4 = (show_if_1) && create_if_block_2();

    	var if_block5 = (show_if) && create_if_block_1();

    	return {
    		c() {
    			div0 = element("div");
    			styleicon.$$.fragment.c();
    			t0 = space();
    			div1 = element("div");
    			if (if_block0) if_block0.c();
    			t1 = space();
    			if (if_block1) if_block1.c();
    			t2 = space();
    			if (if_block2) if_block2.c();
    			t3 = space();
    			if (if_block3) if_block3.c();
    			t4 = space();
    			if (if_block4) if_block4.c();
    			t5 = space();
    			if (if_block5) if_block5.c();
    			attr(div0, "class", "style svelte-1rcdrvh");
    			attr(div1, "class", "meta svelte-1rcdrvh");
    		},

    		m(target_1, anchor) {
    			insert(target_1, div0, anchor);
    			mount_component(styleicon, div0, null);
    			insert(target_1, t0, anchor);
    			insert(target_1, div1, anchor);
    			if (if_block0) if_block0.m(div1, null);
    			append(div1, t1);
    			if (if_block1) if_block1.m(div1, null);
    			append(div1, t2);
    			if (if_block2) if_block2.m(div1, null);
    			append(div1, t3);
    			if (if_block3) if_block3.m(div1, null);
    			append(div1, t4);
    			if (if_block4) if_block4.m(div1, null);
    			append(div1, t5);
    			if (if_block5) if_block5.m(div1, null);
    			current = true;
    		},

    		p(changed, ctx) {
    			var styleicon_changes = {};
    			if (changed.attack) styleicon_changes.style = ctx.attack.style;
    			styleicon.$set(styleicon_changes);

    			if (changed.modifiers) show_if_5 = ctx.modifiers.includes("double");

    			if (show_if_5) {
    				if (!if_block0) {
    					if_block0 = create_if_block_6();
    					if_block0.c();
    					if_block0.m(div1, t1);
    				}
    			} else if (if_block0) {
    				if_block0.d(1);
    				if_block0 = null;
    			}

    			if (changed.modifiers) show_if_4 = ctx.modifiers.includes("break");

    			if (show_if_4) {
    				if (!if_block1) {
    					if_block1 = create_if_block_5();
    					if_block1.c();
    					if_block1.m(div1, t2);
    				}
    			} else if (if_block1) {
    				if_block1.d(1);
    				if_block1 = null;
    			}

    			if (changed.modifiers) show_if_3 = ctx.modifiers.includes("stop");

    			if (show_if_3) {
    				if (!if_block2) {
    					if_block2 = create_if_block_4();
    					if_block2.c();
    					if_block2.m(div1, t3);
    				}
    			} else if (if_block2) {
    				if_block2.d(1);
    				if_block2 = null;
    			}

    			if (changed.modifiers) show_if_2 = ctx.modifiers.includes("jump");

    			if (show_if_2) {
    				if (!if_block3) {
    					if_block3 = create_if_block_3();
    					if_block3.c();
    					if_block3.m(div1, t4);
    				}
    			} else if (if_block3) {
    				if_block3.d(1);
    				if_block3 = null;
    			}

    			if (changed.modifiers) show_if_1 = ctx.modifiers.includes("duck");

    			if (show_if_1) {
    				if (!if_block4) {
    					if_block4 = create_if_block_2();
    					if_block4.c();
    					if_block4.m(div1, t5);
    				}
    			} else if (if_block4) {
    				if_block4.d(1);
    				if_block4 = null;
    			}

    			if (changed.modifiers) show_if = ctx.modifiers.includes("strafe");

    			if (show_if) {
    				if (!if_block5) {
    					if_block5 = create_if_block_1();
    					if_block5.c();
    					if_block5.m(div1, null);
    				}
    			} else if (if_block5) {
    				if_block5.d(1);
    				if_block5 = null;
    			}
    		},

    		i(local) {
    			if (current) return;
    			transition_in(styleicon.$$.fragment, local);

    			current = true;
    		},

    		o(local) {
    			transition_out(styleicon.$$.fragment, local);
    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div0);
    			}

    			destroy_component(styleicon);

    			if (detaching) {
    				detach(t0);
    				detach(div1);
    			}

    			if (if_block0) if_block0.d();
    			if (if_block1) if_block1.d();
    			if (if_block2) if_block2.d();
    			if (if_block3) if_block3.d();
    			if (if_block4) if_block4.d();
    			if (if_block5) if_block5.d();
    		}
    	};
    }

    // (11:4) {#if empty}
    function create_if_block(ctx) {
    	var current;

    	var emptyicon = new Empty_icon({});

    	return {
    		c() {
    			emptyicon.$$.fragment.c();
    		},

    		m(target_1, anchor) {
    			mount_component(emptyicon, target_1, anchor);
    			current = true;
    		},

    		p: noop,

    		i(local) {
    			if (current) return;
    			transition_in(emptyicon.$$.fragment, local);

    			current = true;
    		},

    		o(local) {
    			transition_out(emptyicon.$$.fragment, local);
    			current = false;
    		},

    		d(detaching) {
    			destroy_component(emptyicon, detaching);
    		}
    	};
    }

    // (19:12) {#if modifiers.includes("double")}
    function create_if_block_6(ctx) {
    	var div;

    	return {
    		c() {
    			div = element("div");
    			div.textContent = "DBL";
    			attr(div, "class", "meta-trait svelte-1rcdrvh");
    		},

    		m(target_1, anchor) {
    			insert(target_1, div, anchor);
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div);
    			}
    		}
    	};
    }

    // (23:12) {#if modifiers.includes("break")}
    function create_if_block_5(ctx) {
    	var div;

    	return {
    		c() {
    			div = element("div");
    			div.textContent = "GRB";
    			attr(div, "class", "meta-trait svelte-1rcdrvh");
    		},

    		m(target_1, anchor) {
    			insert(target_1, div, anchor);
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div);
    			}
    		}
    	};
    }

    // (27:12) {#if modifiers.includes("stop")}
    function create_if_block_4(ctx) {
    	var div;

    	return {
    		c() {
    			div = element("div");
    			div.textContent = "STP";
    			attr(div, "class", "meta-trait svelte-1rcdrvh");
    		},

    		m(target_1, anchor) {
    			insert(target_1, div, anchor);
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div);
    			}
    		}
    	};
    }

    // (31:12) {#if modifiers.includes("jump")}
    function create_if_block_3(ctx) {
    	var div;

    	return {
    		c() {
    			div = element("div");
    			div.textContent = "JMP";
    			attr(div, "class", "meta-trait svelte-1rcdrvh");
    		},

    		m(target_1, anchor) {
    			insert(target_1, div, anchor);
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div);
    			}
    		}
    	};
    }

    // (35:12) {#if modifiers.includes("duck")}
    function create_if_block_2(ctx) {
    	var div;

    	return {
    		c() {
    			div = element("div");
    			div.textContent = "DUC";
    			attr(div, "class", "meta-trait svelte-1rcdrvh");
    		},

    		m(target_1, anchor) {
    			insert(target_1, div, anchor);
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div);
    			}
    		}
    	};
    }

    // (39:12) {#if modifiers.includes("strafe")}
    function create_if_block_1(ctx) {
    	var div;

    	return {
    		c() {
    			div = element("div");
    			div.textContent = "STF";
    			attr(div, "class", "meta-trait svelte-1rcdrvh");
    		},

    		m(target_1, anchor) {
    			insert(target_1, div, anchor);
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div);
    			}
    		}
    	};
    }

    function create_fragment$2(ctx) {
    	var div, current_block_type_index, if_block, click_action, hover_action, current, dispose;

    	var if_block_creators = [
    		create_if_block,
    		create_else_block
    	];

    	var if_blocks = [];

    	function select_block_type(changed, ctx) {
    		if (ctx.empty) return 0;
    		return 1;
    	}

    	current_block_type_index = select_block_type(null, ctx);
    	if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);

    	return {
    		c() {
    			div = element("div");
    			if_block.c();
    			attr(div, "class", "flex container svelte-1rcdrvh");
    			attr(div, "data-current-target", ctx.target);
    			attr(div, "data-equipped", ctx.equipped);
    			attr(div, "style", ctx.style);

    			dispose = [
    				listen(div, "click", ctx.click_handler),
    				listen(div, "mouseenter", ctx.mouseenter_handler)
    			];
    		},

    		m(target_1, anchor) {
    			insert(target_1, div, anchor);
    			if_blocks[current_block_type_index].m(div, null);
    			click_action = click.call(null, div) || {};
    			hover_action = hover.call(null, div) || {};
    			current = true;
    		},

    		p(changed, ctx) {
    			var previous_block_index = current_block_type_index;
    			current_block_type_index = select_block_type(changed, ctx);
    			if (current_block_type_index === previous_block_index) {
    				if_blocks[current_block_type_index].p(changed, ctx);
    			} else {
    				group_outros();
    				transition_out(if_blocks[previous_block_index], 1, 1, () => {
    					if_blocks[previous_block_index] = null;
    				});
    				check_outros();

    				if_block = if_blocks[current_block_type_index];
    				if (!if_block) {
    					if_block = if_blocks[current_block_type_index] = if_block_creators[current_block_type_index](ctx);
    					if_block.c();
    				}
    				transition_in(if_block, 1);
    				if_block.m(div, null);
    			}

    			if (!current || changed.target) {
    				attr(div, "data-current-target", ctx.target);
    			}

    			if (!current || changed.equipped) {
    				attr(div, "data-equipped", ctx.equipped);
    			}

    			if (!current || changed.style) {
    				attr(div, "style", ctx.style);
    			}
    		},

    		i(local) {
    			if (current) return;
    			transition_in(if_block);
    			current = true;
    		},

    		o(local) {
    			transition_out(if_block);
    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div);
    			}

    			if_blocks[current_block_type_index].d();
    			if (click_action && typeof click_action.destroy === 'function') click_action.destroy();
    			if (hover_action && typeof hover_action.destroy === 'function') hover_action.destroy();
    			run_all(dispose);
    		}
    	};
    }

    function instance$1($$self, $$props, $$invalidate) {
    	

    // Dispatch events that parents will do things with.
    const bubble = createEventDispatcher();

    let { attack = false, target = false, equipped = false } = $$props;

    	const click_handler = () => bubble("selection", attack);

    	const mouseenter_handler = () => bubble("hover", attack);

    	$$self.$set = $$props => {
    		if ('attack' in $$props) $$invalidate('attack', attack = $$props.attack);
    		if ('target' in $$props) $$invalidate('target', target = $$props.target);
    		if ('equipped' in $$props) $$invalidate('equipped', equipped = $$props.equipped);
    	};

    	let name, height, type, stance, frames, modifiers, _meta, empty, art, style;

    	$$self.$$.update = ($$dirty = { attack: 1, _meta: 1, name: 1, art: 1 }) => {
    		if ($$dirty.attack) { ($$invalidate('name', {
                name      = "",
                height    = "mid",
                type      = "thrust",
                stance    = false,
                frames    = false,
                modifiers = [],
                _meta     = {}
            } = attack, name, $$invalidate('modifiers', modifiers), $$invalidate('attack', attack), $$invalidate('_meta', _meta), $$invalidate('attack', attack))); }
    		if ($$dirty._meta) { $$invalidate('empty', empty = _meta.empty); }
    		if ($$dirty.name) { $$invalidate('art', art = name.split(" ").join("-").toLowerCase()); }
    		if ($$dirty.art) { $$invalidate('style', style = art ? `background-image: url("assets/images/${art}.png")` : ``); }
    	};

    	return {
    		bubble,
    		attack,
    		target,
    		equipped,
    		modifiers,
    		empty,
    		style,
    		click_handler,
    		mouseenter_handler
    	};
    }

    class Attack_tile extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-1rcdrvh-style")) add_css$1();
    		init(this, options, instance$1, create_fragment$2, safe_not_equal, ["attack", "target", "equipped"]);
    	}
    }

    /* src\components\icons\stance-icon.svelte generated by Svelte v3.12.1 */

    function add_css$2() {
    	var style = element("style");
    	style.id = 'svelte-2nk5qq-style';
    	style.textContent = ".svg.svelte-2nk5qq{width:var(--stance-icon-dimension, 2rem);height:var(--stance-icon-dimension, 2rem);margin:0 1rem}.svg[data-empty=\"true\"].svelte-2nk5qq{opacity:0.3}.square.svelte-2nk5qq{stroke:black;stroke-width:0.2rem}.marker.svelte-2nk5qq{fill:#EEE}.group.svelte-2nk5qq{fill:var(--color-gray)}.group[data-glow=\"true\"].svelte-2nk5qq{fill:var(--color-gold)}";
    	append(document.head, style);
    }

    // (4:8) {#if !empty}
    function create_if_block$1(ctx) {
    	var path_1;

    	return {
    		c() {
    			path_1 = svg_element("path");
    			attr(path_1, "class", "marker svelte-2nk5qq");
    			attr(path_1, "d", ctx.path);
    			attr(path_1, "stroke", "black");
    			attr(path_1, "stroke-width", "4");
    		},

    		m(target, anchor) {
    			insert(target, path_1, anchor);
    		},

    		p(changed, ctx) {
    			if (changed.path) {
    				attr(path_1, "d", ctx.path);
    			}
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(path_1);
    			}
    		}
    	};
    }

    function create_fragment$3(ctx) {
    	var svg, g, polygon;

    	var if_block = (!ctx.empty) && create_if_block$1(ctx);

    	return {
    		c() {
    			svg = svg_element("svg");
    			g = svg_element("g");
    			polygon = svg_element("polygon");
    			if (if_block) if_block.c();
    			attr(polygon, "class", "square svelte-2nk5qq");
    			attr(polygon, "points", "0 50, 50 0, 100 50, 50 100");
    			attr(g, "class", "group svelte-2nk5qq");
    			attr(g, "data-glow", ctx.glow);
    			attr(svg, "class", "svg svelte-2nk5qq");
    			attr(svg, "viewBox", "0 0 100 100");
    			attr(svg, "data-empty", ctx.empty);
    		},

    		m(target, anchor) {
    			insert(target, svg, anchor);
    			append(svg, g);
    			append(g, polygon);
    			if (if_block) if_block.m(g, null);
    		},

    		p(changed, ctx) {
    			if (!ctx.empty) {
    				if (if_block) {
    					if_block.p(changed, ctx);
    				} else {
    					if_block = create_if_block$1(ctx);
    					if_block.c();
    					if_block.m(g, null);
    				}
    			} else if (if_block) {
    				if_block.d(1);
    				if_block = null;
    			}

    			if (changed.glow) {
    				attr(g, "data-glow", ctx.glow);
    			}

    			if (changed.empty) {
    				attr(svg, "data-empty", ctx.empty);
    			}
    		},

    		i: noop,
    		o: noop,

    		d(detaching) {
    			if (detaching) {
    				detach(svg);
    			}

    			if (if_block) if_block.d();
    		}
    	};
    }

    function instance$2($$self, $$props, $$invalidate) {
    	let $followup;

    	component_subscribe($$self, followup, $$value => { $followup = $$value; $$invalidate('$followup', $followup); });

    	let { quadrant = false, empty = false, first = false } = $$props;

        
        const stances = {
            FRONT_LEFT : "40 25 L 10 10 L 25 40 Z",
            FRONT_RIGHT : "60 25 L 90 10 75 40 Z",
            BACK_LEFT : "40 75 L 10 90 L 25 60 Z",
            BACK_RIGHT : "60 75 L 90 90 75 60 Z",
        };

    	$$self.$set = $$props => {
    		if ('quadrant' in $$props) $$invalidate('quadrant', quadrant = $$props.quadrant);
    		if ('empty' in $$props) $$invalidate('empty', empty = $$props.empty);
    		if ('first' in $$props) $$invalidate('first', first = $$props.first);
    	};

    	let path, glow;

    	$$self.$$.update = ($$dirty = { quadrant: 1, first: 1, $followup: 1 }) => {
    		if ($$dirty.quadrant) { $$invalidate('path', path = `M 50 50 L ${stances[quadrant]}`); }
    		if ($$dirty.first || $$dirty.$followup || $$dirty.quadrant) { $$invalidate('glow', glow = first && ($followup === quadrant)); }
    	};

    	return { quadrant, empty, first, path, glow };
    }

    class Stance_icon extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-2nk5qq-style")) add_css$2();
    		init(this, options, instance$2, create_fragment$3, safe_not_equal, ["quadrant", "empty", "first"]);
    	}
    }

    /* src\components\attack-string.svelte generated by Svelte v3.12.1 */

    function add_css$3() {
    	var style = element("style");
    	style.id = 'svelte-1p23n9d-style';
    	style.textContent = ".string.svelte-1p23n9d{display:flex;justify-content:center;align-items:center;margin:1rem 0}";
    	append(document.head, style);
    }

    function get_each_context(ctx, list, i) {
    	const child_ctx = Object.create(ctx);
    	child_ctx.attack = list[i];
    	child_ctx.index = i;
    	return child_ctx;
    }

    // (3:4) {#each attacks as attack, index}
    function create_each_block(ctx) {
    	var t, current;

    	function selection_handler(...args) {
    		return ctx.selection_handler(ctx, ...args);
    	}

    	var attack = new Attack_tile({
    		props: { attack: ctx.attack, target: ctx.target === ctx.index }
    	});
    	attack.$on("selection", selection_handler);
    	attack.$on("hover", ctx.hover_handler);

    	var stance = new Stance_icon({
    		props: {
    		empty: ctx.attack._meta.empty,
    		quadrant: ctx.empty(ctx.attack) ? ctx.quadrant : ctx.attack.stance[ctx.$weapon][ctx.beginning(ctx.attack)]
    	}
    	});

    	return {
    		c() {
    			attack.$$.fragment.c();
    			t = space();
    			stance.$$.fragment.c();
    		},

    		m(target_1, anchor) {
    			mount_component(attack, target_1, anchor);
    			insert(target_1, t, anchor);
    			mount_component(stance, target_1, anchor);
    			current = true;
    		},

    		p(changed, new_ctx) {
    			ctx = new_ctx;
    			var attack_changes = {};
    			if (changed.attacks) attack_changes.attack = ctx.attack;
    			if (changed.target) attack_changes.target = ctx.target === ctx.index;
    			attack.$set(attack_changes);

    			var stance_changes = {};
    			if (changed.attacks) stance_changes.empty = ctx.attack._meta.empty;
    			if (changed.attacks || changed.quadrant || changed.$weapon) stance_changes.quadrant = ctx.empty(ctx.attack) ? ctx.quadrant : ctx.attack.stance[ctx.$weapon][ctx.beginning(ctx.attack)];
    			stance.$set(stance_changes);
    		},

    		i(local) {
    			if (current) return;
    			transition_in(attack.$$.fragment, local);

    			transition_in(stance.$$.fragment, local);

    			current = true;
    		},

    		o(local) {
    			transition_out(attack.$$.fragment, local);
    			transition_out(stance.$$.fragment, local);
    			current = false;
    		},

    		d(detaching) {
    			destroy_component(attack, detaching);

    			if (detaching) {
    				detach(t);
    			}

    			destroy_component(stance, detaching);
    		}
    	};
    }

    function create_fragment$4(ctx) {
    	var div, t, current;

    	var stance = new Stance_icon({
    		props: { quadrant: ctx.quadrant, first: true }
    	});

    	let each_value = ctx.attacks;

    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block(get_each_context(ctx, each_value, i));
    	}

    	const out = i => transition_out(each_blocks[i], 1, 1, () => {
    		each_blocks[i] = null;
    	});

    	return {
    		c() {
    			div = element("div");
    			stance.$$.fragment.c();
    			t = space();

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}
    			attr(div, "class", "string svelte-1p23n9d");
    		},

    		m(target_1, anchor) {
    			insert(target_1, div, anchor);
    			mount_component(stance, div, null);
    			append(div, t);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div, null);
    			}

    			current = true;
    		},

    		p(changed, ctx) {
    			var stance_changes = {};
    			if (changed.quadrant) stance_changes.quadrant = ctx.quadrant;
    			stance.$set(stance_changes);

    			if (changed.attacks || changed.empty || changed.quadrant || changed.$weapon || changed.beginning || changed.target) {
    				each_value = ctx.attacks;

    				let i;
    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(changed, child_ctx);
    						transition_in(each_blocks[i], 1);
    					} else {
    						each_blocks[i] = create_each_block(child_ctx);
    						each_blocks[i].c();
    						transition_in(each_blocks[i], 1);
    						each_blocks[i].m(div, null);
    					}
    				}

    				group_outros();
    				for (i = each_value.length; i < each_blocks.length; i += 1) {
    					out(i);
    				}
    				check_outros();
    			}
    		},

    		i(local) {
    			if (current) return;
    			transition_in(stance.$$.fragment, local);

    			for (let i = 0; i < each_value.length; i += 1) {
    				transition_in(each_blocks[i]);
    			}

    			current = true;
    		},

    		o(local) {
    			transition_out(stance.$$.fragment, local);

    			each_blocks = each_blocks.filter(Boolean);
    			for (let i = 0; i < each_blocks.length; i += 1) {
    				transition_out(each_blocks[i]);
    			}

    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div);
    			}

    			destroy_component(stance);

    			destroy_each(each_blocks, detaching);
    		}
    	};
    }

    function instance$3($$self, $$props, $$invalidate) {
    	let $weapon;

    	component_subscribe($$self, weapon, $$value => { $weapon = $$value; $$invalidate('$weapon', $weapon); });

    	

        const bubble = createEventDispatcher();

        let { attacks = [], quadrant = "FRONT_RIGHT", target } = $$props;

        // Given a cell (a tile that can hold an attack), 
        // calculate what quadrant it belongs to.
        const quadify = (attack) => {
            // Is it empty? is anything before it?
            const { _meta } = attack;
            const { previous } = _meta;

            // If there's nothing before the slot we chose, we take the quadrant we were passed
            if(!previous) {
                return quadrant;
            }

            // If there is a previous, we care about generating followups from that 
            // previous attack's ending stance.
            return previous._meta.ends;
        };

        const empty = (attack) => attack._meta.empty;
        const beginning = (attack) => attack._meta.begins;

    	const selection_handler = ({ index }, { detail : attack }) => {
    	                bubble("selection", { 
    	                    column : index,

    	                    attack,
    	                    quadrant : quadify(attack),
    	                });
    	            };

    	const hover_handler = ({ detail : attack }) => bubble("hover", attack);

    	$$self.$set = $$props => {
    		if ('attacks' in $$props) $$invalidate('attacks', attacks = $$props.attacks);
    		if ('quadrant' in $$props) $$invalidate('quadrant', quadrant = $$props.quadrant);
    		if ('target' in $$props) $$invalidate('target', target = $$props.target);
    	};

    	return {
    		bubble,
    		attacks,
    		quadrant,
    		target,
    		quadify,
    		empty,
    		beginning,
    		$weapon,
    		selection_handler,
    		hover_handler
    	};
    }

    class Attack_string extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-1p23n9d-style")) add_css$3();
    		init(this, options, instance$3, create_fragment$4, safe_not_equal, ["attacks", "quadrant", "target"]);
    	}
    }

    /* src\pages\deck-overview.svelte generated by Svelte v3.12.1 */

    function add_css$4() {
    	var style = element("style");
    	style.id = 'svelte-14opis5-style';
    	style.textContent = ".overview.svelte-14opis5{--attack-tile-height:6.5rem;--attack-tile-width:6.5rem;height:100%;width:100%}.deck.svelte-14opis5{grid-area:deck;display:flex;flex-flow:column;justify-content:center;height:100%}.group.svelte-14opis5{display:flex;flex-flow:row wrap}.combo.svelte-14opis5{flex:1\r\n    }.combo[data-primary].svelte-14opis5{flex:2}.combo[data-alternate].svelte-14opis5{align-self:flex-end}";
    	append(document.head, style);
    }

    function get_each_context$1(ctx, list, i) {
    	const child_ctx = Object.create(ctx);
    	child_ctx.quadrant = list[i].quadrant;
    	child_ctx.primary = list[i].primary;
    	child_ctx.alternate = list[i].alternate;
    	child_ctx.row = i;
    	return child_ctx;
    }

    // (3:4) {#each rows as { quadrant, primary, alternate }
    function create_each_block$1(ctx) {
    	var div2, div0, t0, div1, t1, current;

    	function selection_handler(...args) {
    		return ctx.selection_handler(ctx, ...args);
    	}

    	var string0 = new Attack_string({
    		props: {
    		quadrant: ctx.quadrant,
    		attacks: ctx.primary
    	}
    	});
    	string0.$on("selection", selection_handler);
    	string0.$on("hover", ctx.hover_handler);

    	function selection_handler_1(...args) {
    		return ctx.selection_handler_1(ctx, ...args);
    	}

    	var string1 = new Attack_string({
    		props: {
    		quadrant: ctx.quadrant,
    		attacks: ctx.alternate
    	}
    	});
    	string1.$on("selection", selection_handler_1);
    	string1.$on("hover", ctx.hover_handler_1);

    	return {
    		c() {
    			div2 = element("div");
    			div0 = element("div");
    			string0.$$.fragment.c();
    			t0 = space();
    			div1 = element("div");
    			string1.$$.fragment.c();
    			t1 = space();
    			attr(div0, "class", "combo svelte-14opis5");
    			attr(div0, "data-primary", "");
    			attr(div1, "class", "combo svelte-14opis5");
    			attr(div1, "data-alternate", "");
    			attr(div2, "class", "group svelte-14opis5");
    		},

    		m(target, anchor) {
    			insert(target, div2, anchor);
    			append(div2, div0);
    			mount_component(string0, div0, null);
    			append(div2, t0);
    			append(div2, div1);
    			mount_component(string1, div1, null);
    			append(div2, t1);
    			current = true;
    		},

    		p(changed, new_ctx) {
    			ctx = new_ctx;
    			var string0_changes = {};
    			if (changed.rows) string0_changes.quadrant = ctx.quadrant;
    			if (changed.rows) string0_changes.attacks = ctx.primary;
    			string0.$set(string0_changes);

    			var string1_changes = {};
    			if (changed.rows) string1_changes.quadrant = ctx.quadrant;
    			if (changed.rows) string1_changes.attacks = ctx.alternate;
    			string1.$set(string1_changes);
    		},

    		i(local) {
    			if (current) return;
    			transition_in(string0.$$.fragment, local);

    			transition_in(string1.$$.fragment, local);

    			current = true;
    		},

    		o(local) {
    			transition_out(string0.$$.fragment, local);
    			transition_out(string1.$$.fragment, local);
    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div2);
    			}

    			destroy_component(string0);

    			destroy_component(string1);
    		}
    	};
    }

    function create_fragment$5(ctx) {
    	var div1, div0, current;

    	let each_value = ctx.rows;

    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block$1(get_each_context$1(ctx, each_value, i));
    	}

    	const out = i => transition_out(each_blocks[i], 1, 1, () => {
    		each_blocks[i] = null;
    	});

    	return {
    		c() {
    			div1 = element("div");
    			div0 = element("div");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}
    			attr(div0, "class", "deck svelte-14opis5");
    			attr(div1, "class", "overview svelte-14opis5");
    		},

    		m(target, anchor) {
    			insert(target, div1, anchor);
    			append(div1, div0);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div0, null);
    			}

    			current = true;
    		},

    		p(changed, ctx) {
    			if (changed.rows) {
    				each_value = ctx.rows;

    				let i;
    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context$1(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(changed, child_ctx);
    						transition_in(each_blocks[i], 1);
    					} else {
    						each_blocks[i] = create_each_block$1(child_ctx);
    						each_blocks[i].c();
    						transition_in(each_blocks[i], 1);
    						each_blocks[i].m(div0, null);
    					}
    				}

    				group_outros();
    				for (i = each_value.length; i < each_blocks.length; i += 1) {
    					out(i);
    				}
    				check_outros();
    			}
    		},

    		i(local) {
    			if (current) return;
    			for (let i = 0; i < each_value.length; i += 1) {
    				transition_in(each_blocks[i]);
    			}

    			current = true;
    		},

    		o(local) {
    			each_blocks = each_blocks.filter(Boolean);
    			for (let i = 0; i < each_blocks.length; i += 1) {
    				transition_out(each_blocks[i]);
    			}

    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div1);
    			}

    			destroy_each(each_blocks, detaching);
    		}
    	};
    }

    function instance$4($$self, $$props, $$invalidate) {
    	let $deck;

    	component_subscribe($$self, deck, $$value => { $deck = $$value; $$invalidate('$deck', $deck); });

    	

    const set = (attack) => selected.set(attack);

    	const selection_handler = ({ quadrant, primary, row }, { detail }) => state.send("SELECTING", { 
    	                            string   : quadrant,
    	                            quadrant : detail.quadrant,
    	                            attack   : detail.attack,

    	                            combo : primary,
    	                            slot  : {
    	                                row,
    	                                column    : detail.column,
    	                                alternate : false,
    	                            }
    	                        }
    	                    );

    	const hover_handler = ({ detail }) => set(detail);

    	const selection_handler_1 = ({ quadrant, alternate, row }, { detail }) => state.send("SELECTING", { 
    	                            string   : quadrant,
    	                            quadrant : detail.quadrant,
    	                            attack   : detail.attack,

    	                            combo : alternate,
    	                            slot  : {
    	                                row,
    	                                column    : detail.column,
    	                                alternate : true,
    	                            }
    	                        }
    	                    );

    	const hover_handler_1 = ({ detail }) => set(detail);

    	let rows;

    	$$self.$$.update = ($$dirty = { $deck: 1 }) => {
    		if ($$dirty.$deck) { $$invalidate('rows', rows = $deck); }
    	};

    	return {
    		set,
    		rows,
    		selection_handler,
    		hover_handler,
    		selection_handler_1,
    		hover_handler_1
    	};
    }

    class Deck_overview extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-14opis5-style")) add_css$4();
    		init(this, options, instance$4, create_fragment$5, safe_not_equal, []);
    	}
    }

    const action$1 = event => node => {
      const handler = () => state.send(event);

      node.addEventListener("click", handler);
      return () => node.removeEventListener("click", handler);
    };

    /* src\components\attack-info.svelte generated by Svelte v3.12.1 */

    function add_css$5() {
    	var style = element("style");
    	style.id = 'svelte-io4mow-style';
    	style.textContent = ".metadata.svelte-io4mow{grid-area:metadata;display:flex;justify-content:center;align-items:center;color:#CCC;width:var(--attack-info-container-width, 20rem)}.metadata-card.svelte-io4mow{display:flex;justify-content:center;align-items:center;flex-flow:column nowrap;width:100%}.name.svelte-io4mow{color:var(--color-gold);width:100%;font-size:1.2rem}.attack.svelte-io4mow{width:100%;height:15rem;background-position:center;background-color:var(--color-gray);background-position:center;background-repeat:no-repeat}.stats.svelte-io4mow{width:100%;font-weight:800}.stat.svelte-io4mow{display:flex;justify-content:space-between;align-items:center;width:100%;height:2rem;width:100%;padding:0.5rem}.stat.svelte-io4mow:nth-of-type(even){background:var(--color-gray)}.stat.svelte-io4mow:nth-of-type(odd){background:var(--color-gray-dark)}";
    	append(document.head, style);
    }

    function get_each_context$2(ctx, list, i) {
    	const child_ctx = Object.create(ctx);
    	child_ctx.stat = list[i].stat;
    	child_ctx.data = list[i].data;
    	return child_ctx;
    }

    // (7:8) {#each stats as { stat, data }}
    function create_each_block$2(ctx) {
    	var div, span0, t0_value = ctx.stat + "", t0, t1, span1, t2_value = ctx.data + "", t2, t3;

    	return {
    		c() {
    			div = element("div");
    			span0 = element("span");
    			t0 = text(t0_value);
    			t1 = space();
    			span1 = element("span");
    			t2 = text(t2_value);
    			t3 = space();
    			attr(div, "class", "stat svelte-io4mow");
    		},

    		m(target, anchor) {
    			insert(target, div, anchor);
    			append(div, span0);
    			append(span0, t0);
    			append(div, t1);
    			append(div, span1);
    			append(span1, t2);
    			append(div, t3);
    		},

    		p(changed, ctx) {
    			if ((changed.stats) && t0_value !== (t0_value = ctx.stat + "")) {
    				set_data(t0, t0_value);
    			}

    			if ((changed.stats) && t2_value !== (t2_value = ctx.data + "")) {
    				set_data(t2, t2_value);
    			}
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div);
    			}
    		}
    	};
    }

    function create_fragment$6(ctx) {
    	var div3, div2, h1, t0_value = ctx.attack.name + "", t0, t1, div0, t2, div1;

    	let each_value = ctx.stats;

    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block$2(get_each_context$2(ctx, each_value, i));
    	}

    	return {
    		c() {
    			div3 = element("div");
    			div2 = element("div");
    			h1 = element("h1");
    			t0 = text(t0_value);
    			t1 = space();
    			div0 = element("div");
    			t2 = space();
    			div1 = element("div");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}
    			attr(h1, "class", "name svelte-io4mow");
    			attr(div0, "class", "attack svelte-io4mow");
    			attr(div0, "style", ctx.style);
    			attr(div1, "class", "stats svelte-io4mow");
    			attr(div2, "class", "metadata-card svelte-io4mow");
    			attr(div3, "class", "metadata svelte-io4mow");
    		},

    		m(target, anchor) {
    			insert(target, div3, anchor);
    			append(div3, div2);
    			append(div2, h1);
    			append(h1, t0);
    			append(div2, t1);
    			append(div2, div0);
    			append(div2, t2);
    			append(div2, div1);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div1, null);
    			}
    		},

    		p(changed, ctx) {
    			if ((changed.attack) && t0_value !== (t0_value = ctx.attack.name + "")) {
    				set_data(t0, t0_value);
    			}

    			if (changed.style) {
    				attr(div0, "style", ctx.style);
    			}

    			if (changed.stats) {
    				each_value = ctx.stats;

    				let i;
    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context$2(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(changed, child_ctx);
    					} else {
    						each_blocks[i] = create_each_block$2(child_ctx);
    						each_blocks[i].c();
    						each_blocks[i].m(div1, null);
    					}
    				}

    				for (; i < each_blocks.length; i += 1) {
    					each_blocks[i].d(1);
    				}
    				each_blocks.length = each_value.length;
    			}
    		},

    		i: noop,
    		o: noop,

    		d(detaching) {
    			if (detaching) {
    				detach(div3);
    			}

    			destroy_each(each_blocks, detaching);
    		}
    	};
    }

    function instance$5($$self, $$props, $$invalidate) {
    	let { attack = false, quadrant = "FRONT_RIGHT" } = $$props;

    const opposite = (side) => side === "LEFT" ? "RIGHT" : "LEFT";

    	$$self.$set = $$props => {
    		if ('attack' in $$props) $$invalidate('attack', attack = $$props.attack);
    		if ('quadrant' in $$props) $$invalidate('quadrant', quadrant = $$props.quadrant);
    	};

    	let name, height, type, stance, hits, fstyle, frames, modifiers, _meta, look, face, art, style, stats;

    	$$self.$$.update = ($$dirty = { attack: 1, quadrant: 1, name: 1, art: 1, fstyle: 1, height: 1, hits: 1, face: 1, type: 1, frames: 1 }) => {
    		if ($$dirty.attack) { ($$invalidate('name', {
                name      = "",
                height    = "mid",
                type      = "thrust",
                stance    = false,
                hits = "same",
                style : fstyle = "forsaken",
                frames    = { advantage : false },
                modifiers = [],
                _meta     = { empty : true, begins: "" }
            } = attack, name, $$invalidate('height', height), $$invalidate('attack', attack), $$invalidate('type', type), $$invalidate('attack', attack), $$invalidate('hits', hits), $$invalidate('attack', attack), $$invalidate('fstyle', fstyle), $$invalidate('attack', attack), $$invalidate('frames', frames), $$invalidate('attack', attack))); }
    		if ($$dirty.quadrant) { $$invalidate('face', [look, face] = quadrant.split("_"), face); }
    		if ($$dirty.name) { $$invalidate('art', art = name.split(" ").join("-").toLowerCase()); }
    		if ($$dirty.art) { $$invalidate('style', style = art ? `background-image: url("assets/images/${art}.png")` : ``); }
    		if ($$dirty.name || $$dirty.fstyle || $$dirty.height || $$dirty.hits || $$dirty.face || $$dirty.type || $$dirty.frames) { $$invalidate('stats', stats = [
                { stat : "Name", data : name  },
                { stat : "Style", data : fstyle },
                { stat : "Height", data : height },
                { stat : "Side", data : hits === "same" ? face : opposite(face)},
                { stat : "Type", data : type },
                { stat : "Hit", data : frames.advantage.hit},
                { stat : "Guard", data : frames.advantage.guard},
            ]); }
    	};

    	return { attack, quadrant, style, stats };
    }

    class Attack_info extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-io4mow-style")) add_css$5();
    		init(this, options, instance$5, create_fragment$6, safe_not_equal, ["attack", "quadrant"]);
    	}
    }

    /* src\pages\attack-selection.svelte generated by Svelte v3.12.1 */

    function add_css$6() {
    	var style = element("style");
    	style.id = 'svelte-1r9d1k-style';
    	style.textContent = ".container.svelte-1r9d1k{--attack-tile-height:6.5rem;--attack-tile-width:6.5rem;position:relative;display:grid;grid-template:\"structure metadata\" 1fr \r\n            / 2fr 1fr;overflow:hidden;height:100%;width:100%}.metadata.svelte-1r9d1k{display:flex;justify-content:center;align-items:center}.heading.svelte-1r9d1k{display:flex;justify-content:center;align-items:center;padding:1rem 0;margin-bottom:0.25rem;font-size:1.5rem;background:#222;color:white;touch-action:none}.attacks.svelte-1r9d1k{display:grid;grid-gap:0.2rem;padding:0 0.2rem;grid-template-columns:repeat(5, var(--attack-tile-width));flex-flow:row wrap;font-size:0.8rem;flex:1}.selection.svelte-1r9d1k{background:rgba(0,0,0, 0.3);height:70vh;overflow-y:scroll;padding:0 0 0.5rem 0}.structure.svelte-1r9d1k{display:flex;justify-content:center;align-items:center;flex-flow:column nowrap;grid-area:structure;overflow:hidden}";
    	append(document.head, style);
    }

    function get_each_context$3(ctx, list, i) {
    	const child_ctx = Object.create(ctx);
    	child_ctx.component = list[i].component;
    	child_ctx.children = list[i].children;
    	child_ctx.props = list[i].props;
    	return child_ctx;
    }

    function get_each_context_2(ctx, list, i) {
    	const child_ctx = Object.create(ctx);
    	child_ctx.attack = list[i];
    	return child_ctx;
    }

    function get_each_context_1(ctx, list, i) {
    	const child_ctx = Object.create(ctx);
    	child_ctx.quadrant = list[i].stance;
    	child_ctx.attacks = list[i].attacks;
    	return child_ctx;
    }

    // (24:20) {#each attacks as attack (attack.name)}
    function create_each_block_2(key_1, ctx) {
    	var first, current;

    	function selection_handler_1() {
    		return ctx.selection_handler_1(ctx);
    	}

    	function hover_handler(...args) {
    		return ctx.hover_handler(ctx, ...args);
    	}

    	var attack = new Attack_tile({
    		props: {
    		attack: ctx.attack,
    		equipped: ctx.$equipped.includes(ctx.attack.name),
    		facing: ctx.quadrant.split("_")[1]
    	}
    	});
    	attack.$on("selection", selection_handler_1);
    	attack.$on("hover", hover_handler);

    	return {
    		key: key_1,

    		first: null,

    		c() {
    			first = empty();
    			attack.$$.fragment.c();
    			this.first = first;
    		},

    		m(target, anchor) {
    			insert(target, first, anchor);
    			mount_component(attack, target, anchor);
    			current = true;
    		},

    		p(changed, new_ctx) {
    			ctx = new_ctx;
    			var attack_changes = {};
    			if (changed.pool) attack_changes.attack = ctx.attack;
    			if (changed.$equipped || changed.pool) attack_changes.equipped = ctx.$equipped.includes(ctx.attack.name);
    			if (changed.pool) attack_changes.facing = ctx.quadrant.split("_")[1];
    			attack.$set(attack_changes);
    		},

    		i(local) {
    			if (current) return;
    			transition_in(attack.$$.fragment, local);

    			current = true;
    		},

    		o(local) {
    			transition_out(attack.$$.fragment, local);
    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(first);
    			}

    			destroy_component(attack, detaching);
    		}
    	};
    }

    // (19:12) {#each pool as { stance : quadrant, attacks }
    function create_each_block_1(key_1, ctx) {
    	var div0, t0, t1, div1, each_blocks = [], each_1_lookup = new Map(), t2, current;

    	var stance = new Stance_icon({ props: { quadrant: ctx.quadrant } });

    	let each_value_2 = ctx.attacks;

    	const get_key = ctx => ctx.attack.name;

    	for (let i = 0; i < each_value_2.length; i += 1) {
    		let child_ctx = get_each_context_2(ctx, each_value_2, i);
    		let key = get_key(child_ctx);
    		each_1_lookup.set(key, each_blocks[i] = create_each_block_2(key, child_ctx));
    	}

    	return {
    		key: key_1,

    		first: null,

    		c() {
    			div0 = element("div");
    			t0 = text("Ends in ");
    			stance.$$.fragment.c();
    			t1 = space();
    			div1 = element("div");

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			t2 = space();
    			attr(div0, "class", "heading svelte-1r9d1k");
    			attr(div1, "class", "attacks svelte-1r9d1k");
    			this.first = div0;
    		},

    		m(target, anchor) {
    			insert(target, div0, anchor);
    			append(div0, t0);
    			mount_component(stance, div0, null);
    			insert(target, t1, anchor);
    			insert(target, div1, anchor);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(div1, null);
    			}

    			append(div1, t2);
    			current = true;
    		},

    		p(changed, ctx) {
    			var stance_changes = {};
    			if (changed.pool) stance_changes.quadrant = ctx.quadrant;
    			stance.$set(stance_changes);

    			const each_value_2 = ctx.attacks;

    			group_outros();
    			each_blocks = update_keyed_each(each_blocks, changed, get_key, 1, ctx, each_value_2, each_1_lookup, div1, outro_and_destroy_block, create_each_block_2, t2, get_each_context_2);
    			check_outros();
    		},

    		i(local) {
    			if (current) return;
    			transition_in(stance.$$.fragment, local);

    			for (let i = 0; i < each_value_2.length; i += 1) {
    				transition_in(each_blocks[i]);
    			}

    			current = true;
    		},

    		o(local) {
    			transition_out(stance.$$.fragment, local);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				transition_out(each_blocks[i]);
    			}

    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div0);
    			}

    			destroy_component(stance);

    			if (detaching) {
    				detach(t1);
    				detach(div1);
    			}

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].d();
    			}
    		}
    	};
    }

    // (42:12) {#if selected}
    function create_if_block$2(ctx) {
    	var current;

    	var info_spread_levels = [
    		ctx.selected
    	];

    	let info_props = {};
    	for (var i = 0; i < info_spread_levels.length; i += 1) {
    		info_props = assign(info_props, info_spread_levels[i]);
    	}
    	var info = new Attack_info({ props: info_props });

    	return {
    		c() {
    			info.$$.fragment.c();
    		},

    		m(target, anchor) {
    			mount_component(info, target, anchor);
    			current = true;
    		},

    		p(changed, ctx) {
    			var info_changes = (changed.selected) ? get_spread_update(info_spread_levels, [
    									get_spread_object(ctx.selected)
    								]) : {};
    			info.$set(info_changes);
    		},

    		i(local) {
    			if (current) return;
    			transition_in(info.$$.fragment, local);

    			current = true;
    		},

    		o(local) {
    			transition_out(info.$$.fragment, local);
    			current = false;
    		},

    		d(detaching) {
    			destroy_component(info, detaching);
    		}
    	};
    }

    // (49:0) {#each children as { component, children, props }
    function create_each_block$3(ctx) {
    	var switch_instance_anchor, current;

    	var switch_instance_spread_levels = [
    		{ children: ctx.children },
    		ctx.props
    	];

    	var switch_value = ctx.component;

    	function switch_props(ctx) {
    		let switch_instance_props = {};
    		for (var i = 0; i < switch_instance_spread_levels.length; i += 1) {
    			switch_instance_props = assign(switch_instance_props, switch_instance_spread_levels[i]);
    		}
    		return { props: switch_instance_props };
    	}

    	if (switch_value) {
    		var switch_instance = new switch_value(switch_props());
    	}

    	return {
    		c() {
    			if (switch_instance) switch_instance.$$.fragment.c();
    			switch_instance_anchor = empty();
    		},

    		m(target, anchor) {
    			if (switch_instance) {
    				mount_component(switch_instance, target, anchor);
    			}

    			insert(target, switch_instance_anchor, anchor);
    			current = true;
    		},

    		p(changed, ctx) {
    			var switch_instance_changes = (changed.children) ? get_spread_update(switch_instance_spread_levels, [
    									switch_instance_spread_levels[0],
    			get_spread_object(ctx.props)
    								]) : {};

    			if (switch_value !== (switch_value = ctx.component)) {
    				if (switch_instance) {
    					group_outros();
    					const old_component = switch_instance;
    					transition_out(old_component.$$.fragment, 1, 0, () => {
    						destroy_component(old_component, 1);
    					});
    					check_outros();
    				}

    				if (switch_value) {
    					switch_instance = new switch_value(switch_props());

    					switch_instance.$$.fragment.c();
    					transition_in(switch_instance.$$.fragment, 1);
    					mount_component(switch_instance, switch_instance_anchor.parentNode, switch_instance_anchor);
    				} else {
    					switch_instance = null;
    				}
    			}

    			else if (switch_value) {
    				switch_instance.$set(switch_instance_changes);
    			}
    		},

    		i(local) {
    			if (current) return;
    			if (switch_instance) transition_in(switch_instance.$$.fragment, local);

    			current = true;
    		},

    		o(local) {
    			if (switch_instance) transition_out(switch_instance.$$.fragment, local);
    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(switch_instance_anchor);
    			}

    			if (switch_instance) destroy_component(switch_instance, detaching);
    		}
    	};
    }

    function create_fragment$7(ctx) {
    	var div4, div1, t0, div0, each_blocks_1 = [], each0_lookup = new Map(), t1, div3, div2, t2, each1_anchor, current;

    	var string_1 = new Attack_string({
    		props: {
    		quadrant: ctx.string,
    		attacks: ctx.active,
    		target: ctx.slot.column
    	}
    	});
    	string_1.$on("selection", ctx.selection_handler);

    	let each_value_1 = ctx.pool;

    	const get_key = ctx => ctx.quadrant;

    	for (let i = 0; i < each_value_1.length; i += 1) {
    		let child_ctx = get_each_context_1(ctx, each_value_1, i);
    		let key = get_key(child_ctx);
    		each0_lookup.set(key, each_blocks_1[i] = create_each_block_1(key, child_ctx));
    	}

    	var if_block = (ctx.selected) && create_if_block$2(ctx);

    	let each_value = ctx.children;

    	let each_blocks = [];

    	for (let i = 0; i < each_value.length; i += 1) {
    		each_blocks[i] = create_each_block$3(get_each_context$3(ctx, each_value, i));
    	}

    	const out = i => transition_out(each_blocks[i], 1, 1, () => {
    		each_blocks[i] = null;
    	});

    	return {
    		c() {
    			div4 = element("div");
    			div1 = element("div");
    			string_1.$$.fragment.c();
    			t0 = space();
    			div0 = element("div");

    			for (let i = 0; i < each_blocks_1.length; i += 1) {
    				each_blocks_1[i].c();
    			}

    			t1 = space();
    			div3 = element("div");
    			div2 = element("div");
    			if (if_block) if_block.c();
    			t2 = space();

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].c();
    			}

    			each1_anchor = empty();
    			attr(div0, "class", "selection svelte-1r9d1k");
    			attr(div1, "class", "structure svelte-1r9d1k");
    			attr(div2, "class", "metadata-card svelte-1r9d1k");
    			attr(div3, "class", "metadata svelte-1r9d1k");
    			attr(div4, "class", "container svelte-1r9d1k");
    		},

    		m(target, anchor) {
    			insert(target, div4, anchor);
    			append(div4, div1);
    			mount_component(string_1, div1, null);
    			append(div1, t0);
    			append(div1, div0);

    			for (let i = 0; i < each_blocks_1.length; i += 1) {
    				each_blocks_1[i].m(div0, null);
    			}

    			append(div4, t1);
    			append(div4, div3);
    			append(div3, div2);
    			if (if_block) if_block.m(div2, null);
    			insert(target, t2, anchor);

    			for (let i = 0; i < each_blocks.length; i += 1) {
    				each_blocks[i].m(target, anchor);
    			}

    			insert(target, each1_anchor, anchor);
    			current = true;
    		},

    		p(changed, ctx) {
    			var string_1_changes = {};
    			if (changed.string) string_1_changes.quadrant = ctx.string;
    			if (changed.active) string_1_changes.attacks = ctx.active;
    			if (changed.slot) string_1_changes.target = ctx.slot.column;
    			string_1.$set(string_1_changes);

    			const each_value_1 = ctx.pool;

    			group_outros();
    			each_blocks_1 = update_keyed_each(each_blocks_1, changed, get_key, 1, ctx, each_value_1, each0_lookup, div0, outro_and_destroy_block, create_each_block_1, null, get_each_context_1);
    			check_outros();

    			if (ctx.selected) {
    				if (if_block) {
    					if_block.p(changed, ctx);
    					transition_in(if_block, 1);
    				} else {
    					if_block = create_if_block$2(ctx);
    					if_block.c();
    					transition_in(if_block, 1);
    					if_block.m(div2, null);
    				}
    			} else if (if_block) {
    				group_outros();
    				transition_out(if_block, 1, 1, () => {
    					if_block = null;
    				});
    				check_outros();
    			}

    			if (changed.children) {
    				each_value = ctx.children;

    				let i;
    				for (i = 0; i < each_value.length; i += 1) {
    					const child_ctx = get_each_context$3(ctx, each_value, i);

    					if (each_blocks[i]) {
    						each_blocks[i].p(changed, child_ctx);
    						transition_in(each_blocks[i], 1);
    					} else {
    						each_blocks[i] = create_each_block$3(child_ctx);
    						each_blocks[i].c();
    						transition_in(each_blocks[i], 1);
    						each_blocks[i].m(each1_anchor.parentNode, each1_anchor);
    					}
    				}

    				group_outros();
    				for (i = each_value.length; i < each_blocks.length; i += 1) {
    					out(i);
    				}
    				check_outros();
    			}
    		},

    		i(local) {
    			if (current) return;
    			transition_in(string_1.$$.fragment, local);

    			for (let i = 0; i < each_value_1.length; i += 1) {
    				transition_in(each_blocks_1[i]);
    			}

    			transition_in(if_block);

    			for (let i = 0; i < each_value.length; i += 1) {
    				transition_in(each_blocks[i]);
    			}

    			current = true;
    		},

    		o(local) {
    			transition_out(string_1.$$.fragment, local);

    			for (let i = 0; i < each_blocks_1.length; i += 1) {
    				transition_out(each_blocks_1[i]);
    			}

    			transition_out(if_block);

    			each_blocks = each_blocks.filter(Boolean);
    			for (let i = 0; i < each_blocks.length; i += 1) {
    				transition_out(each_blocks[i]);
    			}

    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div4);
    			}

    			destroy_component(string_1);

    			for (let i = 0; i < each_blocks_1.length; i += 1) {
    				each_blocks_1[i].d();
    			}

    			if (if_block) if_block.d();

    			if (detaching) {
    				detach(t2);
    			}

    			destroy_each(each_blocks, detaching);

    			if (detaching) {
    				detach(each1_anchor);
    			}
    		}
    	};
    }

    function instance$6($$self, $$props, $$invalidate) {
    	let $alternates, $primaries, $equipped;

    	component_subscribe($$self, alternates, $$value => { $alternates = $$value; $$invalidate('$alternates', $alternates); });
    	component_subscribe($$self, primaries, $$value => { $primaries = $$value; $$invalidate('$primaries', $primaries); });
    	component_subscribe($$self, equipped$1, $$value => { $equipped = $$value; $$invalidate('$equipped', $equipped); });

    // This all comes from the state chart.
    let { pool, children, string, slot } = $$props;

    let selected = false;

    	const selection_handler = ({ detail }) => {
    	                    ($$invalidate('selected', selected = { 
    	                        attack : detail.attack, 
    	                        quadrant : string
    	                    }));
    	                    state.send("NEW_TARGET", detail);
    	                };

    	const selection_handler_1 = ({ attack }) => state.send("ATTACK_SELECTED", { attack });

    	const hover_handler = ({ quadrant }, { detail : attack }) => {
    	                                ($$invalidate('selected', selected = { attack, quadrant }));
    	                            };

    	$$self.$set = $$props => {
    		if ('pool' in $$props) $$invalidate('pool', pool = $$props.pool);
    		if ('children' in $$props) $$invalidate('children', children = $$props.children);
    		if ('string' in $$props) $$invalidate('string', string = $$props.string);
    		if ('slot' in $$props) $$invalidate('slot', slot = $$props.slot);
    	};

    	let active;

    	$$self.$$.update = ($$dirty = { slot: 1, $alternates: 1, $primaries: 1 }) => {
    		if ($$dirty.slot || $$dirty.$alternates || $$dirty.$primaries) { $$invalidate('active', active = slot.alternate ? $alternates[slot.row] : $primaries[slot.row]); }
    	};

    	return {
    		pool,
    		children,
    		string,
    		slot,
    		selected,
    		active,
    		$equipped,
    		selection_handler,
    		selection_handler_1,
    		hover_handler
    	};
    }

    class Attack_selection extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-1r9d1k-style")) add_css$6();
    		init(this, options, instance$6, create_fragment$7, safe_not_equal, ["pool", "children", "string", "slot"]);
    	}
    }

    /* src\components\override.svelte generated by Svelte v3.12.1 */

    function add_css$7() {
    	var style = element("style");
    	style.id = 'svelte-7wkq9j-style';
    	style.textContent = "p.svelte-7wkq9j{margin:0}.fullscreen.svelte-7wkq9j{position:fixed;display:flex;flex-flow:column nowrap;top:0;justify-content:center;align-items:center;height:100%;width:100%;font-weight:700;color:white;background:rgba(0, 0, 0, 0.5)}.button.svelte-7wkq9j{padding:1rem;border:0.1rem solid black}.button.svelte-7wkq9j:hover{color:white;background-color:black;border-color:white}.modal.svelte-7wkq9j{display:flex;justify-content:space-around;padding:1rem;flex-flow:column nowrap;width:30rem;height:10rem;background-color:black}.actions.svelte-7wkq9j{display:flex;justify-content:center;align-items:center}.button.svelte-7wkq9j{width:5rem}";
    	append(document.head, style);
    }

    function create_fragment$8(ctx) {
    	var div2, div1, p0, t1, p1, t3, div0, button0, accept_action, t5, button1, reject_action;

    	return {
    		c() {
    			div2 = element("div");
    			div1 = element("div");
    			p0 = element("p");
    			p0.textContent = "You've slotted a move that is incompatible with the moves that come after it.";
    			t1 = space();
    			p1 = element("p");
    			p1.textContent = "Would you like to place this move anyway?";
    			t3 = space();
    			div0 = element("div");
    			button0 = element("button");
    			button0.textContent = "Yes";
    			t5 = space();
    			button1 = element("button");
    			button1.textContent = "No";
    			attr(p0, "class", "svelte-7wkq9j");
    			attr(p1, "class", "svelte-7wkq9j");
    			attr(button0, "class", "button svelte-7wkq9j");
    			attr(button1, "class", "button svelte-7wkq9j");
    			attr(div0, "class", "actions svelte-7wkq9j");
    			attr(div1, "class", "modal svelte-7wkq9j");
    			attr(div2, "class", "fullscreen svelte-7wkq9j");
    		},

    		m(target, anchor) {
    			insert(target, div2, anchor);
    			append(div2, div1);
    			append(div1, p0);
    			append(div1, t1);
    			append(div1, p1);
    			append(div1, t3);
    			append(div1, div0);
    			append(div0, button0);
    			accept_action = ctx.accept.call(null, button0) || {};
    			append(div0, t5);
    			append(div0, button1);
    			reject_action = ctx.reject.call(null, button1) || {};
    		},

    		p: noop,
    		i: noop,
    		o: noop,

    		d(detaching) {
    			if (detaching) {
    				detach(div2);
    			}

    			if (accept_action && typeof accept_action.destroy === 'function') accept_action.destroy();
    			if (reject_action && typeof reject_action.destroy === 'function') reject_action.destroy();
    		}
    	};
    }

    function instance$7($$self) {
    	

    const accept = action$1("ACCEPT");
    const reject = action$1("REJECT");

    	return { accept, reject };
    }

    class Override extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-7wkq9j-style")) add_css$7();
    		init(this, options, instance$7, create_fragment$8, safe_not_equal, []);
    	}
    }

    const {
      assign: assign$3
    } = actions; // Lol fuck you eslint

    const machine = Machine;
    const statechart$1 = machine({
      id: "editor",
      initial: "overview",
      context: {
        string: [],
        quadrant: "",
        pool: [],
        slot: {
          row: 0,
          column: 0
        }
      },
      on: {
        OVERVIEW: ".overview",
        // TODO: Warn the user before resetting the deck, probably.
        EQUIP_SWORD: {
          actions: [() => reset(), () => equip("sword")]
        },
        EQUIP_BAREHANDS: {
          actions: [() => reset(), () => equip("barehands")]
        }
      },
      states: {
        overview: {
          on: {
            SELECTING: "selecting"
          },
          meta: {
            component: Deck_overview
          }
        },
        selecting: {
          initial: "idle",
          on: {
            OVERVIEW: "overview",
            NEW_TARGET: {
              actions: [assign$3({
                slot: ({
                  slot
                }, {
                  column
                }) => Object.assign(slot, {
                  column
                }),
                target: (context, {
                  attack
                }) => attack,
                pool: ({
                  slot
                }, {
                  quadrant
                }) => followups(quadrant, slot.alternate ? {
                  exclude: [quadrant]
                } : {})
              })]
            },
            ATTACK_SELECTED: [// Error: Invalid move selected for slot (stance mismatch or duplicate)
            // TODO: A state to handle slotting already equipped moves
            // that might be elsewhere in the deck. old move gotta go, new move gotta be slotted.
            {
              target: ".override",
              // If this attack isn't compatible in the place we're trying to slot it,
              // we're gonna prompt the user to override the string.
              cond: ({
                target
              }, {
                attack
              }) => !compatible(target, attack),
              // Assign the attack into context because if the user chooses
              // to overwrite the string we need to know what to put
              // there instead.
              actions: [assign$3({
                attack: (context, {
                  attack
                }) => attack
              })]
            }, // TODO: Add logic to handle duplication
            // {
            // duplicate(target, attack)
            // }
            // Success: valid move for selected slot
            {
              actions: [// We didn't trip any invalidators, so
              // set the attack
              ({
                slot
              }, {
                attack
              }) => insert$1(slot.alternate ? alternates : primaries, slot, attack)]
            }],
            BACK: "overview"
          },
          entry: [// Populate the pool + target in the context object when we enter.
          assign$3({
            pool: (context, {
              quadrant,
              slot
            }) => followups(quadrant, slot.alternate ? {
              exclude: [quadrant]
            } : {}),
            slot: (context, {
              slot
            }) => slot,
            target: (context, {
              attack
            }) => attack,
            combo: (context, {
              combo
            }) => combo,
            quadrant: (context, {
              quadrant
            }) => quadrant,
            string: (context, {
              string
            }) => string
          })],
          exit: [// Empty the pool in context when we leave, because nothing will be using it.
          assign$3({
            pool: []
          })],
          meta: {
            component: Attack_selection,
            props: context => context
          },
          states: {
            idle: {},
            override: {
              on: {
                // Accept the override, wipe the parts of the deck
                // that are invalidated
                ACCEPT: {
                  target: "idle",
                  actions: [({
                    slot,
                    attack
                  }) => {
                    // Remove everything at slot and forward.
                    remove(slot.alternate ? alternates : primaries, slot, // Nuke everything after the target move, too
                    true); // Insert the new move at slot.

                    insert$1(slot.alternate ? alternates : primaries, slot, attack);
                  }]
                },
                // Reject the override, keep the string you were
                // previously working with.
                REJECT: {
                  target: "idle"
                }
              },
              meta: {
                component: Override
              }
            }
          }
        }
      }
    }); // This is a store that listens to transitions on the statechart,
    // it also exposes the service it creates so xstate-component-tree can work.

    const state = statechart(statechart$1);
    state.start();

    const tree = callback => treeBuilder(state.service, callback);

    var hashids_min = createCommonjsModule(function (module, exports) {
    !function(t,e){e(exports);}("object"==typeof globalThis?globalThis:"object"==typeof self?self:commonjsGlobal,(function(t){function e(t){return function(t){if(Array.isArray(t))return t}(t)||r(t)||function(){throw new TypeError("Invalid attempt to destructure non-iterable instance")}()}function n(t){return function(t){if(Array.isArray(t)){for(var e=0,n=new Array(t.length);e<t.length;e++)n[e]=t[e];return n}}(t)||r(t)||function(){throw new TypeError("Invalid attempt to spread non-iterable instance")}()}function r(t){if(Symbol.iterator in Object(t)||"[object Arguments]"===Object.prototype.toString.call(t))return Array.from(t)}t.__esModule=!0,t.unicodeSubstr=t.onlyChars=t.withoutChars=t.keepUniqueChars=t.default=void 0;var i=function(){function t(t,e,r,i){if(void 0===t&&(t=""),void 0===e&&(e=0),void 0===r&&(r="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"),void 0===i&&(i="cfhistuCFHISTU"),this.salt=t,this.minLength=e,"number"!=typeof e)throw new TypeError("Hashids: Provided 'minLength' has to be a number (is "+typeof e+")");if("string"!=typeof t)throw new TypeError("Hashids: Provided 'salt' has to be a string (is "+typeof t+")");if("string"!=typeof r)throw new TypeError("Hashids: Provided alphabet has to be a string (is "+typeof r+")");var f=h(r);if(f.length<o)throw new Error("Hashids: alphabet must contain at least "+o+" unique characters, provided: "+f);this.alphabet=u(f,i);var d,p,v=l(i,f);this.seps=g(v,t),(0===n(this.seps).length||n(this.alphabet).length/n(this.seps).length>s)&&(d=Math.ceil(n(this.alphabet).length/s))>n(this.seps).length&&(p=d-n(this.seps).length,this.seps+=c(this.alphabet,0,p),this.alphabet=c(this.alphabet,p)),this.alphabet=g(this.alphabet,t);var b=Math.ceil(n(this.alphabet).length/a);n(this.alphabet).length<3?(this.guards=c(this.seps,0,b),this.seps=c(this.seps,b)):(this.guards=c(this.alphabet,0,b),this.alphabet=c(this.alphabet,b));}var r=t.prototype;return r.encode=function(t){for(var e=arguments.length,r=new Array(e>1?e-1:0),i=1;i<e;i++)r[i-1]=arguments[i];var o="";return (r=Array.isArray(t)?t:[].concat(n(null!=t?[t]:[]),n(r))).length?(r.every(f)||(r=r.map((function(t){return "bigint"==typeof t||"number"==typeof t?t:m(String(t))}))),r.every(d)?this._encode(r):o):o},r.decode=function(t){return t&&"string"==typeof t&&0!==t.length?this._decode(t):[]},r.encodeHex=function(t){switch(typeof t){case"bigint":t=t.toString(16);break;case"string":if(!/^[0-9a-fA-F]+$/.test(t))return "";break;default:throw new Error("Hashids: The provided value is neither a string, nor a BigInt (got: "+typeof t+")")}var e=w(t,12,(function(t){return parseInt("1"+t,16)}));return this.encode(e)},r.decodeHex=function(t){return this.decode(t).map((function(t){return t.toString(16).slice(1)})).join("")},r._encode=function(t){var e,r=this,i=this.alphabet,o=t.reduce((function(t,e,n){return t+("bigint"==typeof e?Number(e%BigInt(n+100)):e%(n+100))}),0),s=e=n(i)[o%n(i).length],a=n(this.seps),h=n(this.guards);if(t.forEach((function(n,o){var h=s+r.salt+i;i=g(i,c(h,0));var u=p(n,i);if(e+=u,o+1<t.length){var l=u.codePointAt(0)+o,f="bigint"==typeof n?Number(n%BigInt(l)):n%l;e+=a[f%a.length];}})),n(e).length<this.minLength){var u=(o+n(e)[0].codePointAt(0))%h.length;if(n(e=h[u]+e).length<this.minLength){var l=(o+n(e)[2].codePointAt(0))%h.length;e+=h[l];}}for(var f=Math.floor(n(i).length/2);n(e).length<this.minLength;){i=g(i,i);var d=n(e=c(i,f)+e+c(i,0,f)).length-this.minLength;d>0&&(e=c(e,d/2,this.minLength));}return e},r.isValidId=function(t){var e=this;return n(t).every((function(t){return e.alphabet.includes(t)||e.guards.includes(t)||e.seps.includes(t)}))},r._decode=function(t){var r=this;if(!this.isValidId(t))throw new Error("The provided ID ("+t+") is invalid, as it contains characters that do not exist in the alphabet ("+this.guards+this.seps+this.alphabet+")");var i=b(t,(function(t){return r.guards.includes(t)})),o=n(i[3===i.length||2===i.length?1:0]);if(0===o.length)return [];var s=e(o),a=s[0],h=s.slice(1).join(""),u=b(h,(function(t){return r.seps.includes(t)})).reduce((function(t,e){var i=t.result,o=t.lastAlphabet,s=a+r.salt+o,h=g(o,c(s,0,n(o).length));return {result:[].concat(n(i),[v(e,h)]),lastAlphabet:h}}),{result:[],lastAlphabet:this.alphabet}).result;return this._encode(u)!==t?[]:u},t}();t.default=i;var o=16,s=3.5,a=12,h=function(t){return Array.from(new Set(t)).join("")};t.keepUniqueChars=h;var u=function(t,n){var r=e(t).slice(0),i=e(n).slice(0);return r.filter((function(t){return !i.includes(t)})).join("")};t.withoutChars=u;var l=function(t,n){var r=e(t).slice(0),i=e(n).slice(0);return r.filter((function(t){return i.includes(t)})).join("")};t.onlyChars=l;var c=function(t,n,r){return e(t).slice(0).slice(n,void 0===r?void 0:n+r).join("")};t.unicodeSubstr=c;var f=function(t){return "bigint"==typeof t||!Number.isNaN(Number(t))&&Math.floor(Number(t))===t},d=function(t){return "bigint"==typeof t||t>=0&&Number.isSafeInteger(t)};function g(t,r){var i,o=e(r).slice(0);if(!o.length)return t;for(var s=n(t),a=s.length-1,h=0,u=0;a>0;a--,h++){u+=i=o[h%=o.length].codePointAt(0);var l=(i+h+u)%a,c=[s[a],s[l]];s[l]=c[0],s[a]=c[1];}return s.join("")}var p=function(t,n){var r=e(n).slice(0),i="";if("bigint"==typeof t){var o=BigInt(r.length);do{i=r[Number(t%o)]+i,t/=o;}while(t>BigInt(0))}else do{i=r[t%r.length]+i,t=Math.floor(t/r.length);}while(t>0);return i},v=function(t,n){var r=e(t).slice(0),i=e(n).slice(0);return r.map((function(t){var e=i.indexOf(t);if(-1===e){var n=r.join(""),o=i.join("");throw new Error("The provided ID ("+n+") is invalid, as it contains characters that do not exist in the alphabet ("+o+")")}return e})).reduce((function(t,e){if("bigint"==typeof t)return t*BigInt(i.length)+BigInt(e);var n=t*i.length+e;if(Number.isSafeInteger(n))return n;if("function"==typeof BigInt)return BigInt(t)*BigInt(i.length)+BigInt(e);throw new Error("Unable to decode the provided string, due to lack of support for BigInt numbers in the current environment")}),0)},b=function(t,r){return e(t).slice(0).reduce((function(t,e){return r(e)?[].concat(n(t),[""]):[].concat(n(t.slice(0,-1)),[t[t.length-1]+e])}),[""])},y=/^\+?[0-9]+$/,m=function(t){return y.test(t)?parseInt(t,10):NaN},w=function(t,e,n){return Array.from({length:Math.ceil(t.length/e)},(function(r,i){return n(t.slice(i*e,(i+1)*e))}))};}));

    });

    var Hash = unwrapExports(hashids_min);

    // Clarifier: For decoding indexes back into attacks.

    const obfuscator = new Map(all.map((attack, index) => [attack.name, index]));
    const clarifier = new Map(all.map((attack, index) => [index, attack]));
    obfuscator.set("barehands", 1000);
    clarifier.set(1000, "barehands");
    obfuscator.set("sword", 2000);
    clarifier.set(2000, "sword"); // Return 404 for empty attacks (attacks without names);

    obfuscator.set(false, 404);
    window.obfuscator = obfuscator;
    window.clarifier = clarifier; // Setup an instance of hashing.

    const encoder = new Hash("SALT_SORCERER", 4, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
    /**
     *
     * @param {Array} deck - An Array of objects, each containing `quadrant`, `primary`, and `alternate`
     */

    const deconstruct = deck => {
      /**
       * A flattened representation of every attack in the deck.
       */
      const flattened = deck.reduce((collector, {
        primary,
        alternate
      }) => {
        // Grab every row and concatenate it together
        collector = collector.concat([...primary, ...alternate]);
        return collector;
      }, []);
      const primitives = flattened.map(attack => attack._meta.empty ? obfuscator.get(false) : obfuscator.get(attack.name));
      return [...primitives, obfuscator.get(equipped())];
    };

    const reconstruct = flattened => {
      const [FR1, FR2, FR3, FRA, FL1, FL2, FL3, FLA, BL1, BL2, BL3, BLA, BR1, BR2, BR3, BRA, WEAPON] = flattened.map((code, index) => {
        if (!clarifier.has(code)) {
          return {};
        }

        return clarifier.get(code);
      });
      const p = [[FR1, FR2, FR3], [FL1, FL2, FL3], [BL1, BL2, BL3], [BR1, BR2, BR3]];
      const a = [[FRA], [FLA], [BLA], [BRA]];
      const ip = p.map((atks, row) => atks.map((attack, column) => ({
        attack,
        slot: {
          row,
          column
        },
        target: primaries
      })));
      const ia = a.map((atks, row) => atks.map((attack, column) => ({
        attack,
        slot: {
          row,
          column
        },
        target: alternates
      })));
      equip(WEAPON);
      return {
        primaries: ip,
        alternates: ia
      };
    };
    /**
     *
     * @param {Array} attacks - A flat array of all attacks in the deck, and the weapon for the deck
     *  [FR1, FR2, FR3, FRALT, FL1, FL2, FL3, FLALT, BL1, BL2, BL3, BLALT, BR1, BR2, BR3, BRALT]
     *
     * @returns An encoded Hex-esque string that can be later decoded.
     */


    const encode = deck => {
      const encodable = deconstruct(deck);
      return encoder.encode(encodable);
    };
    /**
     *
     * @param {String} Hash - A Hash to convert to an array
     *
     * @return {Array} - An array of attack objects ready to hydrate the deck
     */


    const decode = hash => {
      const constructable = encoder.decode(hash);
      return reconstruct(constructable);
    };

    /**
     *
     * @param {Object} - Object containing `{ primaries: ..., alternates: ...}`
     * each key is an array of arrays containing `{ attack: ..., slot: ..., target: ... }`
     */

    const hydrate = data => {
      const {
        primaries: _p,
        alternates: _a
      } = data;
      primaries.update(data => {
        _p.forEach(row => {
          row.forEach(({
            attack,
            slot
          }) => {
            insert$1(primaries, slot, attack);
          });
        });

        return data;
      });
      alternates.update(data => {
        _a.forEach(row => {
          row.forEach(({
            attack,
            slot
          }) => {
            insert$1(alternates, slot, attack);
          });
        });

        return data;
      });
    };

    window._hydrate = hydrate;

    var clipboard = createCommonjsModule(function (module, exports) {
    /*!
     * clipboard.js v2.0.4
     * https://zenorocha.github.io/clipboard.js
     * 
     * Licensed MIT © Zeno Rocha
     */
    (function webpackUniversalModuleDefinition(root, factory) {
    	module.exports = factory();
    })(commonjsGlobal, function() {
    return /******/ (function(modules) { // webpackBootstrap
    /******/ 	// The module cache
    /******/ 	var installedModules = {};
    /******/
    /******/ 	// The require function
    /******/ 	function __webpack_require__(moduleId) {
    /******/
    /******/ 		// Check if module is in cache
    /******/ 		if(installedModules[moduleId]) {
    /******/ 			return installedModules[moduleId].exports;
    /******/ 		}
    /******/ 		// Create a new module (and put it into the cache)
    /******/ 		var module = installedModules[moduleId] = {
    /******/ 			i: moduleId,
    /******/ 			l: false,
    /******/ 			exports: {}
    /******/ 		};
    /******/
    /******/ 		// Execute the module function
    /******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
    /******/
    /******/ 		// Flag the module as loaded
    /******/ 		module.l = true;
    /******/
    /******/ 		// Return the exports of the module
    /******/ 		return module.exports;
    /******/ 	}
    /******/
    /******/
    /******/ 	// expose the modules object (__webpack_modules__)
    /******/ 	__webpack_require__.m = modules;
    /******/
    /******/ 	// expose the module cache
    /******/ 	__webpack_require__.c = installedModules;
    /******/
    /******/ 	// define getter function for harmony exports
    /******/ 	__webpack_require__.d = function(exports, name, getter) {
    /******/ 		if(!__webpack_require__.o(exports, name)) {
    /******/ 			Object.defineProperty(exports, name, { enumerable: true, get: getter });
    /******/ 		}
    /******/ 	};
    /******/
    /******/ 	// define __esModule on exports
    /******/ 	__webpack_require__.r = function(exports) {
    /******/ 		if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
    /******/ 			Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    /******/ 		}
    /******/ 		Object.defineProperty(exports, '__esModule', { value: true });
    /******/ 	};
    /******/
    /******/ 	// create a fake namespace object
    /******/ 	// mode & 1: value is a module id, require it
    /******/ 	// mode & 2: merge all properties of value into the ns
    /******/ 	// mode & 4: return value when already ns object
    /******/ 	// mode & 8|1: behave like require
    /******/ 	__webpack_require__.t = function(value, mode) {
    /******/ 		if(mode & 1) value = __webpack_require__(value);
    /******/ 		if(mode & 8) return value;
    /******/ 		if((mode & 4) && typeof value === 'object' && value && value.__esModule) return value;
    /******/ 		var ns = Object.create(null);
    /******/ 		__webpack_require__.r(ns);
    /******/ 		Object.defineProperty(ns, 'default', { enumerable: true, value: value });
    /******/ 		if(mode & 2 && typeof value != 'string') for(var key in value) __webpack_require__.d(ns, key, function(key) { return value[key]; }.bind(null, key));
    /******/ 		return ns;
    /******/ 	};
    /******/
    /******/ 	// getDefaultExport function for compatibility with non-harmony modules
    /******/ 	__webpack_require__.n = function(module) {
    /******/ 		var getter = module && module.__esModule ?
    /******/ 			function getDefault() { return module['default']; } :
    /******/ 			function getModuleExports() { return module; };
    /******/ 		__webpack_require__.d(getter, 'a', getter);
    /******/ 		return getter;
    /******/ 	};
    /******/
    /******/ 	// Object.prototype.hasOwnProperty.call
    /******/ 	__webpack_require__.o = function(object, property) { return Object.prototype.hasOwnProperty.call(object, property); };
    /******/
    /******/ 	// __webpack_public_path__
    /******/ 	__webpack_require__.p = "";
    /******/
    /******/
    /******/ 	// Load entry module and return exports
    /******/ 	return __webpack_require__(__webpack_require__.s = 0);
    /******/ })
    /************************************************************************/
    /******/ ([
    /* 0 */
    /***/ (function(module, exports, __webpack_require__) {


    var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

    var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

    var _clipboardAction = __webpack_require__(1);

    var _clipboardAction2 = _interopRequireDefault(_clipboardAction);

    var _tinyEmitter = __webpack_require__(3);

    var _tinyEmitter2 = _interopRequireDefault(_tinyEmitter);

    var _goodListener = __webpack_require__(4);

    var _goodListener2 = _interopRequireDefault(_goodListener);

    function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

    function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

    function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

    function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

    /**
     * Base class which takes one or more elements, adds event listeners to them,
     * and instantiates a new `ClipboardAction` on each click.
     */
    var Clipboard = function (_Emitter) {
        _inherits(Clipboard, _Emitter);

        /**
         * @param {String|HTMLElement|HTMLCollection|NodeList} trigger
         * @param {Object} options
         */
        function Clipboard(trigger, options) {
            _classCallCheck(this, Clipboard);

            var _this = _possibleConstructorReturn(this, (Clipboard.__proto__ || Object.getPrototypeOf(Clipboard)).call(this));

            _this.resolveOptions(options);
            _this.listenClick(trigger);
            return _this;
        }

        /**
         * Defines if attributes would be resolved using internal setter functions
         * or custom functions that were passed in the constructor.
         * @param {Object} options
         */


        _createClass(Clipboard, [{
            key: 'resolveOptions',
            value: function resolveOptions() {
                var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

                this.action = typeof options.action === 'function' ? options.action : this.defaultAction;
                this.target = typeof options.target === 'function' ? options.target : this.defaultTarget;
                this.text = typeof options.text === 'function' ? options.text : this.defaultText;
                this.container = _typeof(options.container) === 'object' ? options.container : document.body;
            }

            /**
             * Adds a click event listener to the passed trigger.
             * @param {String|HTMLElement|HTMLCollection|NodeList} trigger
             */

        }, {
            key: 'listenClick',
            value: function listenClick(trigger) {
                var _this2 = this;

                this.listener = (0, _goodListener2.default)(trigger, 'click', function (e) {
                    return _this2.onClick(e);
                });
            }

            /**
             * Defines a new `ClipboardAction` on each click event.
             * @param {Event} e
             */

        }, {
            key: 'onClick',
            value: function onClick(e) {
                var trigger = e.delegateTarget || e.currentTarget;

                if (this.clipboardAction) {
                    this.clipboardAction = null;
                }

                this.clipboardAction = new _clipboardAction2.default({
                    action: this.action(trigger),
                    target: this.target(trigger),
                    text: this.text(trigger),
                    container: this.container,
                    trigger: trigger,
                    emitter: this
                });
            }

            /**
             * Default `action` lookup function.
             * @param {Element} trigger
             */

        }, {
            key: 'defaultAction',
            value: function defaultAction(trigger) {
                return getAttributeValue('action', trigger);
            }

            /**
             * Default `target` lookup function.
             * @param {Element} trigger
             */

        }, {
            key: 'defaultTarget',
            value: function defaultTarget(trigger) {
                var selector = getAttributeValue('target', trigger);

                if (selector) {
                    return document.querySelector(selector);
                }
            }

            /**
             * Returns the support of the given action, or all actions if no action is
             * given.
             * @param {String} [action]
             */

        }, {
            key: 'defaultText',


            /**
             * Default `text` lookup function.
             * @param {Element} trigger
             */
            value: function defaultText(trigger) {
                return getAttributeValue('text', trigger);
            }

            /**
             * Destroy lifecycle.
             */

        }, {
            key: 'destroy',
            value: function destroy() {
                this.listener.destroy();

                if (this.clipboardAction) {
                    this.clipboardAction.destroy();
                    this.clipboardAction = null;
                }
            }
        }], [{
            key: 'isSupported',
            value: function isSupported() {
                var action = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : ['copy', 'cut'];

                var actions = typeof action === 'string' ? [action] : action;
                var support = !!document.queryCommandSupported;

                actions.forEach(function (action) {
                    support = support && !!document.queryCommandSupported(action);
                });

                return support;
            }
        }]);

        return Clipboard;
    }(_tinyEmitter2.default);

    /**
     * Helper function to retrieve attribute value.
     * @param {String} suffix
     * @param {Element} element
     */


    function getAttributeValue(suffix, element) {
        var attribute = 'data-clipboard-' + suffix;

        if (!element.hasAttribute(attribute)) {
            return;
        }

        return element.getAttribute(attribute);
    }

    module.exports = Clipboard;

    /***/ }),
    /* 1 */
    /***/ (function(module, exports, __webpack_require__) {


    var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

    var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

    var _select = __webpack_require__(2);

    var _select2 = _interopRequireDefault(_select);

    function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

    function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

    /**
     * Inner class which performs selection from either `text` or `target`
     * properties and then executes copy or cut operations.
     */
    var ClipboardAction = function () {
        /**
         * @param {Object} options
         */
        function ClipboardAction(options) {
            _classCallCheck(this, ClipboardAction);

            this.resolveOptions(options);
            this.initSelection();
        }

        /**
         * Defines base properties passed from constructor.
         * @param {Object} options
         */


        _createClass(ClipboardAction, [{
            key: 'resolveOptions',
            value: function resolveOptions() {
                var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

                this.action = options.action;
                this.container = options.container;
                this.emitter = options.emitter;
                this.target = options.target;
                this.text = options.text;
                this.trigger = options.trigger;

                this.selectedText = '';
            }

            /**
             * Decides which selection strategy is going to be applied based
             * on the existence of `text` and `target` properties.
             */

        }, {
            key: 'initSelection',
            value: function initSelection() {
                if (this.text) {
                    this.selectFake();
                } else if (this.target) {
                    this.selectTarget();
                }
            }

            /**
             * Creates a fake textarea element, sets its value from `text` property,
             * and makes a selection on it.
             */

        }, {
            key: 'selectFake',
            value: function selectFake() {
                var _this = this;

                var isRTL = document.documentElement.getAttribute('dir') == 'rtl';

                this.removeFake();

                this.fakeHandlerCallback = function () {
                    return _this.removeFake();
                };
                this.fakeHandler = this.container.addEventListener('click', this.fakeHandlerCallback) || true;

                this.fakeElem = document.createElement('textarea');
                // Prevent zooming on iOS
                this.fakeElem.style.fontSize = '12pt';
                // Reset box model
                this.fakeElem.style.border = '0';
                this.fakeElem.style.padding = '0';
                this.fakeElem.style.margin = '0';
                // Move element out of screen horizontally
                this.fakeElem.style.position = 'absolute';
                this.fakeElem.style[isRTL ? 'right' : 'left'] = '-9999px';
                // Move element to the same position vertically
                var yPosition = window.pageYOffset || document.documentElement.scrollTop;
                this.fakeElem.style.top = yPosition + 'px';

                this.fakeElem.setAttribute('readonly', '');
                this.fakeElem.value = this.text;

                this.container.appendChild(this.fakeElem);

                this.selectedText = (0, _select2.default)(this.fakeElem);
                this.copyText();
            }

            /**
             * Only removes the fake element after another click event, that way
             * a user can hit `Ctrl+C` to copy because selection still exists.
             */

        }, {
            key: 'removeFake',
            value: function removeFake() {
                if (this.fakeHandler) {
                    this.container.removeEventListener('click', this.fakeHandlerCallback);
                    this.fakeHandler = null;
                    this.fakeHandlerCallback = null;
                }

                if (this.fakeElem) {
                    this.container.removeChild(this.fakeElem);
                    this.fakeElem = null;
                }
            }

            /**
             * Selects the content from element passed on `target` property.
             */

        }, {
            key: 'selectTarget',
            value: function selectTarget() {
                this.selectedText = (0, _select2.default)(this.target);
                this.copyText();
            }

            /**
             * Executes the copy operation based on the current selection.
             */

        }, {
            key: 'copyText',
            value: function copyText() {
                var succeeded = void 0;

                try {
                    succeeded = document.execCommand(this.action);
                } catch (err) {
                    succeeded = false;
                }

                this.handleResult(succeeded);
            }

            /**
             * Fires an event based on the copy operation result.
             * @param {Boolean} succeeded
             */

        }, {
            key: 'handleResult',
            value: function handleResult(succeeded) {
                this.emitter.emit(succeeded ? 'success' : 'error', {
                    action: this.action,
                    text: this.selectedText,
                    trigger: this.trigger,
                    clearSelection: this.clearSelection.bind(this)
                });
            }

            /**
             * Moves focus away from `target` and back to the trigger, removes current selection.
             */

        }, {
            key: 'clearSelection',
            value: function clearSelection() {
                if (this.trigger) {
                    this.trigger.focus();
                }

                window.getSelection().removeAllRanges();
            }

            /**
             * Sets the `action` to be performed which can be either 'copy' or 'cut'.
             * @param {String} action
             */

        }, {
            key: 'destroy',


            /**
             * Destroy lifecycle.
             */
            value: function destroy() {
                this.removeFake();
            }
        }, {
            key: 'action',
            set: function set() {
                var action = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 'copy';

                this._action = action;

                if (this._action !== 'copy' && this._action !== 'cut') {
                    throw new Error('Invalid "action" value, use either "copy" or "cut"');
                }
            }

            /**
             * Gets the `action` property.
             * @return {String}
             */
            ,
            get: function get() {
                return this._action;
            }

            /**
             * Sets the `target` property using an element
             * that will be have its content copied.
             * @param {Element} target
             */

        }, {
            key: 'target',
            set: function set(target) {
                if (target !== undefined) {
                    if (target && (typeof target === 'undefined' ? 'undefined' : _typeof(target)) === 'object' && target.nodeType === 1) {
                        if (this.action === 'copy' && target.hasAttribute('disabled')) {
                            throw new Error('Invalid "target" attribute. Please use "readonly" instead of "disabled" attribute');
                        }

                        if (this.action === 'cut' && (target.hasAttribute('readonly') || target.hasAttribute('disabled'))) {
                            throw new Error('Invalid "target" attribute. You can\'t cut text from elements with "readonly" or "disabled" attributes');
                        }

                        this._target = target;
                    } else {
                        throw new Error('Invalid "target" value, use a valid Element');
                    }
                }
            }

            /**
             * Gets the `target` property.
             * @return {String|HTMLElement}
             */
            ,
            get: function get() {
                return this._target;
            }
        }]);

        return ClipboardAction;
    }();

    module.exports = ClipboardAction;

    /***/ }),
    /* 2 */
    /***/ (function(module, exports) {

    function select(element) {
        var selectedText;

        if (element.nodeName === 'SELECT') {
            element.focus();

            selectedText = element.value;
        }
        else if (element.nodeName === 'INPUT' || element.nodeName === 'TEXTAREA') {
            var isReadOnly = element.hasAttribute('readonly');

            if (!isReadOnly) {
                element.setAttribute('readonly', '');
            }

            element.select();
            element.setSelectionRange(0, element.value.length);

            if (!isReadOnly) {
                element.removeAttribute('readonly');
            }

            selectedText = element.value;
        }
        else {
            if (element.hasAttribute('contenteditable')) {
                element.focus();
            }

            var selection = window.getSelection();
            var range = document.createRange();

            range.selectNodeContents(element);
            selection.removeAllRanges();
            selection.addRange(range);

            selectedText = selection.toString();
        }

        return selectedText;
    }

    module.exports = select;


    /***/ }),
    /* 3 */
    /***/ (function(module, exports) {

    function E () {
      // Keep this empty so it's easier to inherit from
      // (via https://github.com/lipsmack from https://github.com/scottcorgan/tiny-emitter/issues/3)
    }

    E.prototype = {
      on: function (name, callback, ctx) {
        var e = this.e || (this.e = {});

        (e[name] || (e[name] = [])).push({
          fn: callback,
          ctx: ctx
        });

        return this;
      },

      once: function (name, callback, ctx) {
        var self = this;
        function listener () {
          self.off(name, listener);
          callback.apply(ctx, arguments);
        }
        listener._ = callback;
        return this.on(name, listener, ctx);
      },

      emit: function (name) {
        var data = [].slice.call(arguments, 1);
        var evtArr = ((this.e || (this.e = {}))[name] || []).slice();
        var i = 0;
        var len = evtArr.length;

        for (i; i < len; i++) {
          evtArr[i].fn.apply(evtArr[i].ctx, data);
        }

        return this;
      },

      off: function (name, callback) {
        var e = this.e || (this.e = {});
        var evts = e[name];
        var liveEvents = [];

        if (evts && callback) {
          for (var i = 0, len = evts.length; i < len; i++) {
            if (evts[i].fn !== callback && evts[i].fn._ !== callback)
              liveEvents.push(evts[i]);
          }
        }

        // Remove event from queue to prevent memory leak
        // Suggested by https://github.com/lazd
        // Ref: https://github.com/scottcorgan/tiny-emitter/commit/c6ebfaa9bc973b33d110a84a307742b7cf94c953#commitcomment-5024910

        (liveEvents.length)
          ? e[name] = liveEvents
          : delete e[name];

        return this;
      }
    };

    module.exports = E;


    /***/ }),
    /* 4 */
    /***/ (function(module, exports, __webpack_require__) {

    var is = __webpack_require__(5);
    var delegate = __webpack_require__(6);

    /**
     * Validates all params and calls the right
     * listener function based on its target type.
     *
     * @param {String|HTMLElement|HTMLCollection|NodeList} target
     * @param {String} type
     * @param {Function} callback
     * @return {Object}
     */
    function listen(target, type, callback) {
        if (!target && !type && !callback) {
            throw new Error('Missing required arguments');
        }

        if (!is.string(type)) {
            throw new TypeError('Second argument must be a String');
        }

        if (!is.fn(callback)) {
            throw new TypeError('Third argument must be a Function');
        }

        if (is.node(target)) {
            return listenNode(target, type, callback);
        }
        else if (is.nodeList(target)) {
            return listenNodeList(target, type, callback);
        }
        else if (is.string(target)) {
            return listenSelector(target, type, callback);
        }
        else {
            throw new TypeError('First argument must be a String, HTMLElement, HTMLCollection, or NodeList');
        }
    }

    /**
     * Adds an event listener to a HTML element
     * and returns a remove listener function.
     *
     * @param {HTMLElement} node
     * @param {String} type
     * @param {Function} callback
     * @return {Object}
     */
    function listenNode(node, type, callback) {
        node.addEventListener(type, callback);

        return {
            destroy: function() {
                node.removeEventListener(type, callback);
            }
        }
    }

    /**
     * Add an event listener to a list of HTML elements
     * and returns a remove listener function.
     *
     * @param {NodeList|HTMLCollection} nodeList
     * @param {String} type
     * @param {Function} callback
     * @return {Object}
     */
    function listenNodeList(nodeList, type, callback) {
        Array.prototype.forEach.call(nodeList, function(node) {
            node.addEventListener(type, callback);
        });

        return {
            destroy: function() {
                Array.prototype.forEach.call(nodeList, function(node) {
                    node.removeEventListener(type, callback);
                });
            }
        }
    }

    /**
     * Add an event listener to a selector
     * and returns a remove listener function.
     *
     * @param {String} selector
     * @param {String} type
     * @param {Function} callback
     * @return {Object}
     */
    function listenSelector(selector, type, callback) {
        return delegate(document.body, selector, type, callback);
    }

    module.exports = listen;


    /***/ }),
    /* 5 */
    /***/ (function(module, exports) {

    /**
     * Check if argument is a HTML element.
     *
     * @param {Object} value
     * @return {Boolean}
     */
    exports.node = function(value) {
        return value !== undefined
            && value instanceof HTMLElement
            && value.nodeType === 1;
    };

    /**
     * Check if argument is a list of HTML elements.
     *
     * @param {Object} value
     * @return {Boolean}
     */
    exports.nodeList = function(value) {
        var type = Object.prototype.toString.call(value);

        return value !== undefined
            && (type === '[object NodeList]' || type === '[object HTMLCollection]')
            && ('length' in value)
            && (value.length === 0 || exports.node(value[0]));
    };

    /**
     * Check if argument is a string.
     *
     * @param {Object} value
     * @return {Boolean}
     */
    exports.string = function(value) {
        return typeof value === 'string'
            || value instanceof String;
    };

    /**
     * Check if argument is a function.
     *
     * @param {Object} value
     * @return {Boolean}
     */
    exports.fn = function(value) {
        var type = Object.prototype.toString.call(value);

        return type === '[object Function]';
    };


    /***/ }),
    /* 6 */
    /***/ (function(module, exports, __webpack_require__) {

    var closest = __webpack_require__(7);

    /**
     * Delegates event to a selector.
     *
     * @param {Element} element
     * @param {String} selector
     * @param {String} type
     * @param {Function} callback
     * @param {Boolean} useCapture
     * @return {Object}
     */
    function _delegate(element, selector, type, callback, useCapture) {
        var listenerFn = listener.apply(this, arguments);

        element.addEventListener(type, listenerFn, useCapture);

        return {
            destroy: function() {
                element.removeEventListener(type, listenerFn, useCapture);
            }
        }
    }

    /**
     * Delegates event to a selector.
     *
     * @param {Element|String|Array} [elements]
     * @param {String} selector
     * @param {String} type
     * @param {Function} callback
     * @param {Boolean} useCapture
     * @return {Object}
     */
    function delegate(elements, selector, type, callback, useCapture) {
        // Handle the regular Element usage
        if (typeof elements.addEventListener === 'function') {
            return _delegate.apply(null, arguments);
        }

        // Handle Element-less usage, it defaults to global delegation
        if (typeof type === 'function') {
            // Use `document` as the first parameter, then apply arguments
            // This is a short way to .unshift `arguments` without running into deoptimizations
            return _delegate.bind(null, document).apply(null, arguments);
        }

        // Handle Selector-based usage
        if (typeof elements === 'string') {
            elements = document.querySelectorAll(elements);
        }

        // Handle Array-like based usage
        return Array.prototype.map.call(elements, function (element) {
            return _delegate(element, selector, type, callback, useCapture);
        });
    }

    /**
     * Finds closest match and invokes callback.
     *
     * @param {Element} element
     * @param {String} selector
     * @param {String} type
     * @param {Function} callback
     * @return {Function}
     */
    function listener(element, selector, type, callback) {
        return function(e) {
            e.delegateTarget = closest(e.target, selector);

            if (e.delegateTarget) {
                callback.call(element, e);
            }
        }
    }

    module.exports = delegate;


    /***/ }),
    /* 7 */
    /***/ (function(module, exports) {

    var DOCUMENT_NODE_TYPE = 9;

    /**
     * A polyfill for Element.matches()
     */
    if (typeof Element !== 'undefined' && !Element.prototype.matches) {
        var proto = Element.prototype;

        proto.matches = proto.matchesSelector ||
                        proto.mozMatchesSelector ||
                        proto.msMatchesSelector ||
                        proto.oMatchesSelector ||
                        proto.webkitMatchesSelector;
    }

    /**
     * Finds the closest parent that matches a selector.
     *
     * @param {Element} element
     * @param {String} selector
     * @return {Function}
     */
    function closest (element, selector) {
        while (element && element.nodeType !== DOCUMENT_NODE_TYPE) {
            if (typeof element.matches === 'function' &&
                element.matches(selector)) {
              return element;
            }
            element = element.parentNode;
        }
    }

    module.exports = closest;


    /***/ })
    /******/ ]);
    });
    });

    var clipboard$1 = unwrapExports(clipboard);

    function fade ( node, ref ) {
    	var delay = ref.delay; if ( delay === void 0 ) delay = 0;
    	var duration = ref.duration; if ( duration === void 0 ) duration = 400;

    	var o = +getComputedStyle( node ).opacity;

    	return {
    		delay: delay,
    		duration: duration,
    		css: function (t) { return ("opacity: " + (t * o)); }
    	};
    }

    /* src\components\menu-bar.svelte generated by Svelte v3.12.1 */

    function add_css$8() {
    	var style = element("style");
    	style.id = 'svelte-1an0i98-style';
    	style.textContent = ".menu.svelte-1an0i98{display:flex;align-items:center;justify-content:flex-start;background:rgba(255, 255, 255, 0.2);color:#FFF;width:100%;height:100%;padding:0.5rem 0;border-bottom:0.1rem solid #000}.section.title.svelte-1an0i98{margin:0;border:0;padding:0 1rem;width:18rem;font-size:2rem}.section.svelte-1an0i98{height:100%;display:flex;align-items:center;padding:1rem;border-left:0.1rem solid black}.share.svelte-1an0i98{border-left:0.1rem solid black;width:100%}.copy-success.svelte-1an0i98{padding:0 0.5rem}.button.svelte-1an0i98{outline:0;width:6rem;height:3rem;background:#222;border:0;outline:0.1rem solid transparent;color:#eee;transition:all 250ms linear}.button.svelte-1an0i98:hover{background:#666}.button+.button.svelte-1an0i98{margin-left:0.5rem}.button[data-active=\"true\"].svelte-1an0i98{outline:0.1rem solid var(--color-gold)}.button[disabled].svelte-1an0i98{opacity:0.4;pointer-events:none}.return.svelte-1an0i98{cursor:pointer}";
    	append(document.head, style);
    }

    // (8:8) {:else}
    function create_else_block$1(ctx) {
    	var span, dispose;

    	return {
    		c() {
    			span = element("span");
    			span.textContent = "BACK";
    			attr(span, "class", "return svelte-1an0i98");
    			dispose = listen(span, "click", ctx.click_handler);
    		},

    		m(target, anchor) {
    			insert(target, span, anchor);
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(span);
    			}

    			dispose();
    		}
    	};
    }

    // (6:8) {#if overview}
    function create_if_block_1$1(ctx) {
    	var t;

    	return {
    		c() {
    			t = text("Absolver.dev");
    		},

    		m(target, anchor) {
    			insert(target, t, anchor);
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(t);
    			}
    		}
    	};
    }

    // (44:8) {#if copied}
    function create_if_block$3(ctx) {
    	var div, div_transition, current;

    	return {
    		c() {
    			div = element("div");
    			div.textContent = "Successfully copied deck URL to clipboard!";
    			attr(div, "class", "copy-success svelte-1an0i98");
    		},

    		m(target, anchor) {
    			insert(target, div, anchor);
    			current = true;
    		},

    		i(local) {
    			if (current) return;
    			add_render_callback(() => {
    				if (!div_transition) div_transition = create_bidirectional_transition(div, fade, {}, true);
    				div_transition.run(1);
    			});

    			current = true;
    		},

    		o(local) {
    			if (!div_transition) div_transition = create_bidirectional_transition(div, fade, {}, false);
    			div_transition.run(0);

    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div);
    				if (div_transition) div_transition.end();
    			}
    		}
    	};
    }

    function create_fragment$9(ctx) {
    	var div3, div0, t0, div1, button0, t1, barehands_action, t2, button1, t3, sword_action, t4, div2, button2, t5, button2_data_clipboard_text_value, t6, current, dispose;

    	function select_block_type(changed, ctx) {
    		if (ctx.overview) return create_if_block_1$1;
    		return create_else_block$1;
    	}

    	var current_block_type = select_block_type(null, ctx);
    	var if_block0 = current_block_type(ctx);

    	var if_block1 = (ctx.copied) && create_if_block$3();

    	return {
    		c() {
    			div3 = element("div");
    			div0 = element("div");
    			if_block0.c();
    			t0 = space();
    			div1 = element("div");
    			button0 = element("button");
    			t1 = text("Fist");
    			t2 = space();
    			button1 = element("button");
    			t3 = text("Sword");
    			t4 = space();
    			div2 = element("div");
    			button2 = element("button");
    			t5 = text("Share");
    			t6 = space();
    			if (if_block1) if_block1.c();
    			attr(div0, "class", "section title svelte-1an0i98");
    			attr(button0, "class", "button barehands svelte-1an0i98");
    			button0.disabled = ctx.disabled;
    			attr(button0, "data-active", ctx.hands);
    			attr(button1, "class", "button sword svelte-1an0i98");
    			button1.disabled = ctx.disabled;
    			attr(button1, "data-active", ctx.blade);
    			attr(div1, "class", "section toggle svelte-1an0i98");
    			attr(button2, "data-clipboard-dependent", "");
    			attr(button2, "data-clipboard-text", button2_data_clipboard_text_value = `https://absolver.dev/?deck=${encode(ctx.$deck)}`);
    			attr(button2, "class", "button svelte-1an0i98");
    			attr(div2, "class", "section share svelte-1an0i98");
    			attr(div3, "class", "menu svelte-1an0i98");
    			dispose = listen(window, "keydown", ctx.keydown_handler);
    		},

    		m(target, anchor) {
    			insert(target, div3, anchor);
    			append(div3, div0);
    			if_block0.m(div0, null);
    			append(div3, t0);
    			append(div3, div1);
    			append(div1, button0);
    			append(button0, t1);
    			barehands_action = ctx.barehands.call(null, button0) || {};
    			append(div1, t2);
    			append(div1, button1);
    			append(button1, t3);
    			sword_action = ctx.sword.call(null, button1) || {};
    			append(div3, t4);
    			append(div3, div2);
    			append(div2, button2);
    			append(button2, t5);
    			append(div2, t6);
    			if (if_block1) if_block1.m(div2, null);
    			current = true;
    		},

    		p(changed, ctx) {
    			if (current_block_type !== (current_block_type = select_block_type(changed, ctx))) {
    				if_block0.d(1);
    				if_block0 = current_block_type(ctx);
    				if (if_block0) {
    					if_block0.c();
    					if_block0.m(div0, null);
    				}
    			}

    			if (!current || changed.disabled) {
    				button0.disabled = ctx.disabled;
    			}

    			if (!current || changed.hands) {
    				attr(button0, "data-active", ctx.hands);
    			}

    			if (!current || changed.disabled) {
    				button1.disabled = ctx.disabled;
    			}

    			if (!current || changed.blade) {
    				attr(button1, "data-active", ctx.blade);
    			}

    			if ((!current || changed.$deck) && button2_data_clipboard_text_value !== (button2_data_clipboard_text_value = `https://absolver.dev/?deck=${encode(ctx.$deck)}`)) {
    				attr(button2, "data-clipboard-text", button2_data_clipboard_text_value);
    			}

    			if (ctx.copied) {
    				if (!if_block1) {
    					if_block1 = create_if_block$3();
    					if_block1.c();
    					transition_in(if_block1, 1);
    					if_block1.m(div2, null);
    				} else transition_in(if_block1, 1);
    			} else if (if_block1) {
    				group_outros();
    				transition_out(if_block1, 1, 1, () => {
    					if_block1 = null;
    				});
    				check_outros();
    			}
    		},

    		i(local) {
    			if (current) return;
    			transition_in(if_block1);
    			current = true;
    		},

    		o(local) {
    			transition_out(if_block1);
    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div3);
    			}

    			if_block0.d();
    			if (barehands_action && typeof barehands_action.destroy === 'function') barehands_action.destroy();
    			if (sword_action && typeof sword_action.destroy === 'function') sword_action.destroy();
    			if (if_block1) if_block1.d();
    			dispose();
    		}
    	};
    }

    function instance$8($$self, $$props, $$invalidate) {
    	let $state, $weapon, $deck;

    	component_subscribe($$self, state, $$value => { $state = $$value; $$invalidate('$state', $state); });
    	component_subscribe($$self, weapon, $$value => { $weapon = $$value; $$invalidate('$weapon', $weapon); });
    	component_subscribe($$self, deck, $$value => { $deck = $$value; $$invalidate('$deck', $deck); });

    	

    const clippy = new clipboard$1("[data-clipboard-dependent]");

    let copied = false;

    const sword = action$1("EQUIP_SWORD");
    const barehands = action$1("EQUIP_BAREHANDS");


    clippy.on("success", () => ($$invalidate('copied', copied = true)));

    	const keydown_handler = ({ key }) => key === "Escape" ? state.send("BACK") : false;

    	const click_handler = () => state.send("BACK");

    	let overview, disabled, hands, blade;

    	$$self.$$.update = ($$dirty = { $state: 1, overview: 1, $weapon: 1 }) => {
    		if ($$dirty.$state) { $$invalidate('overview', overview = $state.matches("overview")); }
    		if ($$dirty.overview) { $$invalidate('disabled', disabled = !overview); }
    		if ($$dirty.$weapon) { $$invalidate('hands', hands = $weapon === "barehands"); }
    		if ($$dirty.$weapon) { $$invalidate('blade', blade = $weapon === "sword"); }
    	};

    	return {
    		copied,
    		sword,
    		barehands,
    		overview,
    		disabled,
    		hands,
    		blade,
    		$deck,
    		keydown_handler,
    		click_handler
    	};
    }

    class Menu_bar extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-1an0i98-style")) add_css$8();
    		init(this, options, instance$8, create_fragment$9, safe_not_equal, []);
    	}
    }

    /* src\pages\application.svelte generated by Svelte v3.12.1 */

    function add_css$9() {
    	var style = element("style");
    	style.id = 'svelte-1n5edd6-style';
    	style.textContent = ".variables.svelte-1n5edd6{--color-gold:#FBF5DC;--color-gray:#545255;--color-gray-darker:#444;--color-gray-lighter:#677479;--color-equipped-icon-background:#e0c220;--attack-info-container-width:16rem}.application.svelte-1n5edd6{display:grid;grid-template:\"menu\" 4rem\r\n            \"content\" 1fr\r\n            / 1fr;height:100%;font-family:FjallaOne, sans-serif;background:linear-gradient(to right, rgba(0,0,0, 0.5), rgba(0,0,0, 0.5)),\r\n            url(\"assets/backgrounds/application-background.jpg\");background-position:0 0;background-repeat:no-repeat;transition:background-position 250ms ease}.application[data-overview=\"false\"].svelte-1n5edd6{background-position:100% 0}.menu.svelte-1n5edd6{grid-area:menu}.content.svelte-1n5edd6{grid-area:content;padding:1.5rem 0;overflow:hidden}";
    	append(document.head, style);
    }

    function create_fragment$a(ctx) {
    	var div2, div0, t, div1, current;

    	var menubar = new Menu_bar({});

    	var switch_instance_spread_levels = [
    		{ children: ctx.children },
    		ctx.props
    	];

    	var switch_value = ctx.component;

    	function switch_props(ctx) {
    		let switch_instance_props = {};
    		for (var i = 0; i < switch_instance_spread_levels.length; i += 1) {
    			switch_instance_props = assign(switch_instance_props, switch_instance_spread_levels[i]);
    		}
    		return { props: switch_instance_props };
    	}

    	if (switch_value) {
    		var switch_instance = new switch_value(switch_props());
    	}

    	return {
    		c() {
    			div2 = element("div");
    			div0 = element("div");
    			menubar.$$.fragment.c();
    			t = space();
    			div1 = element("div");
    			if (switch_instance) switch_instance.$$.fragment.c();
    			attr(div0, "class", "menu svelte-1n5edd6");
    			attr(div1, "class", "content svelte-1n5edd6");
    			attr(div2, "class", "application variables svelte-1n5edd6");
    			attr(div2, "data-overview", ctx.overview);
    		},

    		m(target, anchor) {
    			insert(target, div2, anchor);
    			append(div2, div0);
    			mount_component(menubar, div0, null);
    			append(div2, t);
    			append(div2, div1);

    			if (switch_instance) {
    				mount_component(switch_instance, div1, null);
    			}

    			current = true;
    		},

    		p(changed, ctx) {
    			var switch_instance_changes = (changed.children || changed.props) ? get_spread_update(switch_instance_spread_levels, [
    									(changed.children) && { children: ctx.children },
    			(changed.props) && get_spread_object(ctx.props)
    								]) : {};

    			if (switch_value !== (switch_value = ctx.component)) {
    				if (switch_instance) {
    					group_outros();
    					const old_component = switch_instance;
    					transition_out(old_component.$$.fragment, 1, 0, () => {
    						destroy_component(old_component, 1);
    					});
    					check_outros();
    				}

    				if (switch_value) {
    					switch_instance = new switch_value(switch_props());

    					switch_instance.$$.fragment.c();
    					transition_in(switch_instance.$$.fragment, 1);
    					mount_component(switch_instance, div1, null);
    				} else {
    					switch_instance = null;
    				}
    			}

    			else if (switch_value) {
    				switch_instance.$set(switch_instance_changes);
    			}

    			if (!current || changed.overview) {
    				attr(div2, "data-overview", ctx.overview);
    			}
    		},

    		i(local) {
    			if (current) return;
    			transition_in(menubar.$$.fragment, local);

    			if (switch_instance) transition_in(switch_instance.$$.fragment, local);

    			current = true;
    		},

    		o(local) {
    			transition_out(menubar.$$.fragment, local);
    			if (switch_instance) transition_out(switch_instance.$$.fragment, local);
    			current = false;
    		},

    		d(detaching) {
    			if (detaching) {
    				detach(div2);
    			}

    			destroy_component(menubar);

    			if (switch_instance) destroy_component(switch_instance);
    		}
    	};
    }

    function instance$9($$self, $$props, $$invalidate) {
    	let $state;

    	component_subscribe($$self, state, $$value => { $state = $$value; $$invalidate('$state', $state); });

    	

    let components = [];

    // If you use the each, spread this in the svelte:component because otherwise child components don't... get there.
    // const workaround = {};

    // We only care about the first chart
    tree(([ structure ]) => {
        $$invalidate('components', components = structure.children);
    });

    // We hydrate the deck if a shared param exists, This is what allows you to share decks.
    const params = new URLSearchParams(window.location.search);
    const deck = params.has("deck") ? params.get("deck") : false;

    if(deck) {
        const decoded = decode(params.get("deck"));

        hydrate(decoded);
    }

    	let root, component, children, props, overview;

    	$$self.$$.update = ($$dirty = { components: 1, root: 1, $state: 1, overview: 1 }) => {
    		if ($$dirty.components) { $$invalidate('root', [ root = false ] = components, root); }
    		if ($$dirty.root) { ($$invalidate('component', { component, children, props } = root, component, $$invalidate('children', children), $$invalidate('root', root), $$invalidate('components', components), $$invalidate('props', props), $$invalidate('root', root), $$invalidate('components', components))); }
    		if ($$dirty.$state) { $$invalidate('overview', overview = $state.matches("overview")); }
    		if ($$dirty.overview) ;
    	};

    	return { component, children, props, overview };
    }

    class Application extends SvelteComponent {
    	constructor(options) {
    		super();
    		if (!document.getElementById("svelte-1n5edd6-style")) add_css$9();
    		init(this, options, instance$9, create_fragment$a, safe_not_equal, []);
    	}
    }

    new Application({
      target: document.body
    });

}());