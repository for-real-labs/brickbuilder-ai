<!-- Adapted from docs/agent/technic.md, docs/agent/mechanisms.md, docs/agent/snapping.md, docs/agent/validation.md and instructions.md of ldraw-nova by Carlos Antelo, with additions by Jake Johnson. CC BY-SA 4.0; see NOTICE.md. Changes: shortened and rewritten for build scripts and for the checks the report runs; the toolkit's commands and structure contracts are left out. -->
## Joints that are not studs

The report measures these from connector data, so a part must be on its real seat, not near it.

- **Made-for pairs.** A tyre fits the rim made for it, a pane or door the frame made for it. Use `inset()` or the helpers: they put the nested part on its seat. Another size sitting in the same place is refused as `[fit]`.
- **Pins.** A Technic pin joins two parts only when each of its two grips is centred in a hole: the pin's middle is on the plane where the two parts meet. Hole centres are 20 LDU (one stud) apart. A pin pushed part of the way in is refused as `[technic]`. Two thin beams can share one grip; one thin beam alone does not hold a pin.
- **Axles.** An axle must reach right through every hole it passes. A cross hole keys the part to the axle; a round hole is a bearing that lets it turn. Neither keeps the axle from sliding out: put a bush or another keyed part against each end of what the axle carries. The report warns when an axle has no stop at both ends, and when one pin leaves two beams free to pivot: two pins a stud or more apart make the joint rigid.
- **Bars, clips and hinges** join where the bar is in the clip or the hinge halves mesh, on one line.

For anything that moves or carries a load, prove the mounts before adding bodywork: build the smallest complete joint first (frame, axle, wheel or sprocket and the bushes that hold it; a boom with both its pivot and its actuator mount), get it through the report, then build outward. If a joint is refused, read which two parts and where, and either seat it or choose another way to mount it. Do not hide a refused joint with `allow_overlap` or `connect()`: neither covers it.

The report does not prove strength, balance, that a hand can reach a part, or that a mechanism moves. Say so when it matters.
