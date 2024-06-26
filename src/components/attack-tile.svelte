<div
    class="flex container"
    data-current-target={target}
    data-equipped={equipped}
    data-hit={hit}
    {style}
    on:click={equipped ? () => {} : () => bubble("selection", attack)}
    on:mouseenter={() => bubble("hover", attack)}
    use:click
    use:hover
>
    {#if _meta.empty}
        <EmptyIcon />
    {:else}
        {#if deletable}
            <div
                class="delete"
                on:click|stopPropagation={() => bubble("deletion")}
            >
                X
            </div>
        {/if}
        <div class="style">
            <StyleIcon style={attack.style} />
            <span class={$enableColors ? getHitSideClass(hit) : null}
                >{hit}</span
            >
            <span class="end">{attack.frames.startup}F</span>
        </div>

        {#if $enableTypeLabel}
            <div class="type-label">
                {height + " - " + type}
            </div>
        {/if}

        <div class="meta">
            <span>+{frames.advantage.hit} / +{frames.advantage.guard}</span>
            {#each modifiers as modifier}
                {#if modifier === "double"}
                    <div class="meta-trait">2X</div>
                {:else}
                    <div
                        class="meta-trait {$enableColors
                            ? getModifierClass(modifier)
                            : null}"
                        style={$enableColors
                            ? stylizeColor(modifier)
                            : stylize(modifier)}
                    ></div>
                {/if}
            {/each}
        </div>
    {/if}
</div>

<script>
    import { createEventDispatcher } from "svelte";
    import followups from "utilities/followups.js";
    import { click, hover } from "actions/audio.js";

    import EmptyIcon from "components/icons/empty-icon.svelte";
    import StyleIcon from "components/icons/style-icon.svelte";

    import { enableColors, enableTypeLabel } from "stores/settings.js";

    const fallback = (value, fallback) => (value ? value : fallback);

    const bubble = createEventDispatcher();

    const opposite = (side) => (side === "LEFT" ? "RIGHT" : "LEFT");

    export let attack = false;
    export let target = false;
    export let equipped = false;
    export let deletable = false;
    export let origin;

    $: name = fallback(attack.name, "");
    $: height = fallback(attack.height, "");
    $: type = fallback(attack.type, "");
    $: stance = fallback(attack.stance, {});
    $: frames = fallback(attack.frames, {});
    $: modifiers = fallback(attack.modifiers, []);
    $: _meta = fallback(attack._meta, {});

    $: art = name.split(" ").join("-").toLowerCase();
    $: style = art ? `background-image: url("assets/images/${art}.png")` : ``;

    $: [fb, lr] = origin ? origin.split("_") : [false, false];

    let hit;

    $: {
        hit = attack.hits === "same" ? lr : opposite(lr);
        if (attack.hits === "both") {
            hit = "BOTH";
        }
    }

    const stylize = (modifier) => {
        return `background-image: url(assets/modifiers/${modifier}.svg)`;
    };

    const stylizeColor = (modifier) => {
        return `-webkit-mask-image: url(assets/modifiers/${modifier}.svg); mask-image: url(assets/modifiers/${modifier}.svg);`;
    };

    const getHitSideClass = (side) => {
        if (side === "RIGHT") return "hit-right";
        if (side === "LEFT") return "hit-left";
        if (side === "BOTH") return "hit-both";
    };

    const getModifierClass = (modifier) => {
        if (modifier === "jump" || modifier === "duck" || modifier === "strafe")
            return "modifier-avoid";
        if (modifier === "break") return "modifier-break";
        if (modifier === "charge") return "modifier-charge";
        if (modifier === "hit-left" || modifier == "hit-right")
            return "modifier-parry";
        if (modifier === "stop") return "modifier-stop";
    };
</script>

<style>
    @keyframes oscillate {
        0% {
            outline: 0.15rem solid var(--color-gold);
        }

        50% {
            outline: 0.15rem solid transparent;
        }

        100% {
            outline: 0.15rem solid var(--color-gold);
        }
    }

    .flex {
        display: flex;
        justify-content: center;
        align-items: center;
    }

    .container {
        position: relative;

        height: var(--deck-overview-attack-tile-height);
        width: var(--deck-overview-attack-tile-width);

        background-color: rgba(0, 0, 0, 0.55);
        color: #fff;

        background-size: 90%;
        background-position: center;
        background-repeat: no-repeat;

        cursor: pointer;
        user-select: none;
    }

    .container:hover,
    .container[data-current-target="true"] {
        animation-name: oscillate;
        animation-duration: 1.5s;
        animation-iteration-count: infinite;
    }

    .container .delete {
        display: none;
    }

    .container:hover .delete {
        display: block;
        position: absolute;
        top: 0;
        right: 0;
        z-index: 3;
    }

    .container[data-equipped="true"] {
        opacity: 0.25;
    }

    .style {
        display: flex;
        flex-flow: row nowrap;
        width: 100%;
        height: 1rem;
        padding: 0.4rem 0.2rem;

        position: absolute;
        top: 0;

        font-size: 0.6rem;
        justify-content: space-between;
        align-items: center;
    }

    .meta {
        display: flex;
        flex-flow: row nowrap;
        width: 100%;
        padding: 0.2rem;

        position: absolute;
        bottom: 0;

        font-size: 0.6rem;

        justify-content: flex-end;

        align-items: center;
        justify-content: space-between;
    }

    .meta-trait + .meta-trait {
        padding: 0 0.2rem;
    }

    .meta-trait {
        height: 1rem;
        width: 1rem;

        display: flex;
        align-items: center;
        justify-content: center;
    }

    .delete {
        text-align: center;
        width: 1rem;
        height: 1rem;
        font-weight: bold;
        color: white;
    }

    .delete::after {
        position: absolute;
        z-index: -1;
        content: "";
        width: 0px;
        height: 0px;
        border-top: 2rem solid var(--color-mork-red);
        border-left: 2rem solid transparent;
        top: 0;
        right: 0;
    }

    .hit-left {
        color: var(--color-hit-left);
    }

    .hit-right {
        color: var(--color-hit-right);
    }

    .hit-both {
        color: var(--color-hit-both);
    }

    .modifier-avoid {
        background-color: var(--color-modifier-avoid);
    }

    .modifier-break {
        background-color: var(--color-modifier-break);
    }

    .modifier-charge {
        background-color: var(--color-modifier-charge);
    }

    .modifier-parry {
        background-color: var(--color-modifier-parry);
    }

    .modifier-stop {
        background-color: var(--color-modifier-stop);
    }

    .type-label {
        display: flex;
        justify-content: center;
        width: 100%;
        background-color: rgba(0, 0, 0, 0.65);
        font-size: 0.7rem;
        text-transform: uppercase;
    }
</style>
