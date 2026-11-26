<!-- Adapted from docs/agent/vehicles.md of ldraw-nova by Carlos Antelo. CC BY-SA 4.0; see NOTICE.md. Changes: shortened and rewritten for build scripts and the wheels and chassis helpers; the toolkit's commands, recipes and fixed coordinate frame are left out. -->
## Vehicles

Choose the wheels before the chassis and the body: the tyre's size sets everything around it. Then fix one layout and keep to it: where each axle is, the track (distance between left and right tyres), the wheelbase, the front and rear overhang, body width, sill height, where the glass starts and how tall the roof is.

- **Scale.** Four studs wide is a compact car, six a town car or van, eight a detailed model. Decide whether a seat and a driver must fit, or the cabin is only glazing.
- **Stance.** Tyres slightly inside or flush with the body sides, enough ground clearance to see the tyre, wheelbase and overhangs that suit the subject. A bus, a sports car and a delivery van do not share proportions.
- **Masses.** Bonnet length, windscreen rake, cabin position and height, rear deck or cargo volume. Say what makes this vehicle different from a box on wheels.
- **Identity.** One strong front (lights and grille), a matching rear, and a continuous line along the shoulders. Keep bonnet, roof and sides quiet.
- **Use the parts made for it:** real seats, a steering wheel, a windscreen, mudguards, a hull, wings, engine housings. Reserve their space first and build the body to them.

What the report holds a vehicle to:

- A tyre must be the one made for its rim, seated on it, and the rim on its pin or axle. The `wheels` helper does this; a tyre placed by hand on a rim of another size is refused.
- Every tyre should stand on the same ground, in a left and right pair on each axle, mirrored about the middle of the vehicle and the same size. A motorcycle has one wheel per axle, on the centre line.
- Nothing but the tyres may reach below them, or the model rests on its body. A base or road plate under the tyres is fine.
- Leave each wheel well free: no plate or brick inside the circle a tyre turns in.
