// three.js render layers shared by the world, the car rig and the mirror cameras.
// Anything that must show in the live mirrors needs obj.layers.enable(MIRROR_LAYER) on every mesh and light.
export const MIRROR_LAYER = 1;
