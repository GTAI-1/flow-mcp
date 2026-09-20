export interface Technique {
  id: string;
  category: "camera" | "product" | "transition" | "image";
  name: string;
  needs?: string;
  phrase: string;
}

// Prompt fragments for common film moves. One per scene: two camera instructions fight each other.
export const TECHNIQUES: Technique[] = [
  // camera
  { id: "dolly-zoom", category: "camera", name: "Dolly zoom (vertigo)", phrase: "Dolly zoom: the camera tracks backward while zooming in, the subject stays the same size in frame while the background stretches away behind them." },
  { id: "snap-zoom-eyes", category: "camera", name: "Snap zoom to eyes", phrase: "Sudden snap zoom from a medium shot straight into an extreme close-up of the eyes, ending perfectly sharp." },
  { id: "crash-zoom", category: "camera", name: "Crash zoom", phrase: "Aggressive crash zoom toward the subject that stops abruptly with a slight impact shake." },
  { id: "orbit-360", category: "camera", name: "Orbit 360", phrase: "The camera orbits a full 360 degrees around the subject at constant height while the subject stays frozen in place, bullet-time style." },
  { id: "frozen-time", category: "camera", name: "Frozen time", phrase: "Time is frozen: droplets, debris and fabric hang motionless in the air while the camera glides slowly through the scene." },
  { id: "speed-ramp", category: "camera", name: "Speed ramp", phrase: "One continuous shot with a speed ramp: slow motion, a burst of fast motion, then slow motion again, no cuts." },
  { id: "fpv-flythrough", category: "camera", name: "FPV fly-through", phrase: "FPV drone shot flying fast and low, weaving between obstacles in a single continuous take." },
  { id: "pull-back-reveal", category: "camera", name: "Pull-back reveal", phrase: "The camera pulls straight back from a close-up to a very wide shot, revealing the true scale of the surroundings." },
  { id: "static", category: "camera", name: "Locked-off static", phrase: "Locked-off static camera on a tripod, no camera movement, no cuts, a single framing for the whole shot." },
  { id: "handheld", category: "camera", name: "Handheld documentary", phrase: "Handheld documentary camera with subtle natural shake and small reframing, observational feel." },
  { id: "lateral-track", category: "camera", name: "Lateral tracking", phrase: "The camera tracks sideways parallel to the subject at a steady pace, foreground elements sliding past for parallax." },
  { id: "crane-up", category: "camera", name: "Crane up", phrase: "The camera cranes smoothly upward from eye level to a high angle, opening the scene from above." },
  { id: "top-down", category: "camera", name: "Top-down", phrase: "Strict top-down overhead shot, camera pointing straight down, perfectly perpendicular to the surface." },
  { id: "zoom-out-to-space", category: "camera", name: "Zoom out to space", phrase: "One continuous pull-back that starts on the subject and rises through the clouds until the whole Earth is visible from space." },
  // product
  { id: "hero-rotation", category: "product", name: "Hero rotation", needs: "one product photo as reference_images", phrase: "The exact product from the reference image rotates slowly on a dark studio pedestal, rim light tracing its edges, shape and label unchanged." },
  { id: "levitation", category: "product", name: "Levitation", needs: "one product photo as reference_images", phrase: "The exact product from the reference image floats in mid-air and turns slowly, soft shadow beneath it, premium studio look." },
  { id: "liquid-splash", category: "product", name: "Liquid splash", needs: "one product photo as reference_images", phrase: "Liquid splashes around the product in extreme slow motion, droplets catching the light, the product stays sharp and unchanged." },
  { id: "macro-bokeh", category: "product", name: "Macro bokeh", needs: "one product photo as reference_images", phrase: "Extreme macro close-up gliding across the product surface, shallow depth of field, golden bokeh highlights in the background." },
  { id: "turntable", category: "product", name: "Turntable", needs: "one product photo as reference_images", phrase: "The product sits on a slowly rotating turntable, camera completely static, clean seamless backdrop, even soft light." },
  { id: "bloom", category: "product", name: "Bloom timelapse", phrase: "Flower buds around the product open in timelapse, fresh natural light, the product stays still in the centre." },
  { id: "inner-glow", category: "product", name: "Inner glow", needs: "one product photo as reference_images", phrase: "The product begins to glow from within, light pulsing softly through it and spilling onto the dark surroundings." },
  { id: "talking-avatar", category: "product", name: "Talking avatar", needs: "one portrait as first_frame, the line in quotes in the prompt", phrase: "The person looks into the camera and speaks the quoted line with natural facial expressions and accurate lip sync, static medium close-up." },
  // transitions (first_frame + last_frame)
  { id: "whip-pan", category: "transition", name: "Whip pan", needs: "first_frame and last_frame", phrase: "A fast whip pan with heavy motion blur sweeps the first scene away and lands on the final frame." },
  { id: "into-the-screen", category: "transition", name: "Into the screen", needs: "first_frame and last_frame", phrase: "The camera pushes into a screen inside the first frame until its image fills the view and becomes the final frame." },
  { id: "seamless-loop", category: "transition", name: "Seamless loop", needs: "the same image as first_frame and last_frame", phrase: "The motion ends exactly where it started so the clip loops seamlessly with no visible seam." },
  { id: "before-after", category: "transition", name: "Before / after", needs: "first_frame and last_frame", phrase: "The first frame transforms smoothly and continuously into the final frame, camera static, a clear before-and-after change." },
  { id: "match-cut", category: "transition", name: "Match cut morph", needs: "first_frame and last_frame", phrase: "The main shapes of the first frame flow and morph into the matching shapes of the final frame." },
  { id: "logo-resolve", category: "transition", name: "Logo resolve", needs: "logo image as last_frame", phrase: "The elements of the scene break apart, swirl together and assemble into the logo shown in the final frame." },
  { id: "particle-dissolve", category: "transition", name: "Particle dissolve", needs: "first_frame and last_frame", phrase: "The subject disintegrates into fine particles that drift and reassemble into the subject of the final frame." },
  { id: "axis-flip", category: "transition", name: "Axis flip", needs: "first_frame and last_frame", phrase: "The camera rolls a full turn around its lens axis and settles on the final frame as the new scene." },
  // image commands (type: image, photo as reference_images)
  { id: "img-hero-shot", category: "image", name: "Product hero shot", needs: "product photo as reference_images", phrase: "Turn this product photo into a premium studio hero shot on a dark pedestal with controlled rim lighting; keep the product identical." },
  { id: "img-white-bg", category: "image", name: "White background", needs: "product photo as reference_images", phrase: "Place the same product on a pure white seamless background with a soft natural shadow, marketplace listing style; keep the product identical." },
  { id: "img-cleanup", category: "image", name: "Remove clutter", needs: "photo as reference_images", phrase: "Remove clutter and stray objects from the image; leave everything else exactly as it is." },
  { id: "img-restore", category: "image", name: "Restore old photo", needs: "photo as reference_images", phrase: "Restore this old photograph: remove scratches and dust, recover natural colour, keep every face exactly as it is." },
  { id: "img-figurine", category: "image", name: "Collectible figurine", needs: "portrait as reference_images", phrase: "Turn the person in the photo into a detailed collectible figurine on a round display stand, on a desk, realistic product photography." },
  { id: "img-outfit", category: "image", name: "Change outfit", needs: "portrait as reference_images, describe the outfit", phrase: "Keep the same person, face, pose and background; change only the clothing as described." },
  { id: "img-flat-lay", category: "image", name: "Flat lay", phrase: "Neat flat lay of the items shot strictly from above on a clean surface, even soft light." },
  { id: "img-cinematic", category: "image", name: "Cinematic keyframe", phrase: "Cinematic film still, 85mm lens, shallow depth of field, golden hour light, subtle film grain." },
  { id: "img-insert-person", category: "image", name: "Person into scene", needs: "two reference_images: the person and the scene", phrase: "Place the person from the first image into the scene from the second image with matching light and perspective; keep the face unchanged." },
];

export const techniqueById = (id: string) => TECHNIQUES.find((t) => t.id === id);
