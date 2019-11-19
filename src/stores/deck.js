import { writable, derived } from "svelte/store";

import barehands from "data/barehands.js";

import { combo, configure } from "stores/utilities.js";

import quadrants from "utilities/quadrants.js";
import { encode, decode } from "utilities/encoder.js";

window._encode = encode;
window._decode = decode;

// Data structures representing the entire state of primary
// strings and alternates in our deck.
const primaries = writable(combo(3));
const alternates = writable(combo(1));

// Derive a deck object that keeps the most up to date deck attack / stance flow information
const deck = derived([ primaries, alternates ], ([ _p, _a ], set) => {
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
            primary   : p,
            alternate : a,
        };
    });

    console.log({ map });

    set(map);
});

deck.subscribe((data) => {
    /**
     * A flattened representation of every attack in the deck.
     */
    // const flattened = data.reduce((collector, { primary, alternate }) => {
    //     const { attacks: _p } = primary;
    //     const { attacks: _a } = alternate;

    //     collector = collector.concat([ ..._p, ..._a ]);

    //     return collector;
    // }, []);

    // window.toencode = flattened;
});

export {
    barehands,

    primaries,
    alternates,

    deck,
};
