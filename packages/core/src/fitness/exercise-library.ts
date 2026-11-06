/**
 * Built-in exercise library (original descriptions, written for this product). Copied into each
 * gym's own library on first use; `key` is stable forever (never rename one, only add).
 */
export const MUSCLES = [
  "chest",
  "back",
  "shoulders",
  "biceps",
  "triceps",
  "forearms",
  "core",
  "quads",
  "hamstrings",
  "glutes",
  "calves",
  "full_body",
  "cardio",
] as const;
export const EQUIPMENT = [
  "bodyweight",
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "cable",
  "band",
  "bench",
  "pullup_bar",
  "cardio_machine",
  "medicine_ball",
  "other",
] as const;
export type LibraryExercise = {
  key: string; // snake_case, unique, e.g. "barbell_back_squat"
  name: string; // e.g. "Barbell back squat"
  primaryMuscle: (typeof MUSCLES)[number];
  muscleGroups: (typeof MUSCLES)[number][]; // secondary muscles, may be empty, never repeats primaryMuscle
  equipment: (typeof EQUIPMENT)[number];
  measure: "REPS" | "TIME" | "DISTANCE"; // how a set is recorded: reps (with optional weight), seconds held/worked, or metres
  level: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
  instructions: string; // 2–3 short plain-English sentences: setup, movement, one safety/form cue. Original wording.
};

export const EXERCISE_LIBRARY: LibraryExercise[] = [
  // ── Chest ──────────────────────────────────────────────────────────────
  {
    key: "barbell_bench_press",
    name: "Barbell bench press",
    primaryMuscle: "chest",
    muscleGroups: ["triceps", "shoulders"],
    equipment: "barbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Lie on a flat bench with your eyes under the bar and feet planted. Lower the bar to your mid-chest, then press it back up until your arms are straight. Keep your shoulder blades pulled together and always use a spotter or safety pins for heavy sets.",
  },
  {
    key: "incline_barbell_bench_press",
    name: "Incline barbell bench press",
    primaryMuscle: "chest",
    muscleGroups: ["shoulders", "triceps"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Set the bench to roughly 30 degrees and grip the bar a little wider than your shoulders. Lower it to your upper chest and press up and slightly back over your face. Keep your hips on the bench rather than arching to finish a rep.",
  },
  {
    key: "dumbbell_bench_press",
    name: "Dumbbell bench press",
    primaryMuscle: "chest",
    muscleGroups: ["triceps", "shoulders"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit with the dumbbells on your thighs, then lie back and bring them beside your chest. Press both up until they nearly touch above you, then lower slowly to a comfortable stretch. Keep your wrists stacked over your elbows throughout.",
  },
  {
    key: "incline_dumbbell_press",
    name: "Incline dumbbell press",
    primaryMuscle: "chest",
    muscleGroups: ["shoulders", "triceps"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Set a bench to a low incline and start with the dumbbells at upper-chest height. Press them up in a slight arc so they finish over your collarbones. Lower under control instead of letting the weights drop into the bottom position.",
  },
  {
    key: "dumbbell_fly",
    name: "Dumbbell fly",
    primaryMuscle: "chest",
    muscleGroups: ["shoulders"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Lie on a flat bench holding light dumbbells above your chest with palms facing each other. With a soft bend in the elbows, open your arms wide until you feel a stretch across the chest, then hug them back together. Stop the descent at shoulder level; going deeper strains the shoulder joint.",
  },
  {
    key: "dumbbell_pullover",
    name: "Dumbbell pullover",
    primaryMuscle: "chest",
    muscleGroups: ["back", "triceps"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Lie across or along a bench holding one dumbbell with both hands above your chest. Keeping the elbows slightly bent, lower it back behind your head, then pull it back over your chest. Move slowly and keep your ribs down so your lower back does not arch.",
  },
  {
    key: "machine_chest_press",
    name: "Machine chest press",
    primaryMuscle: "chest",
    muscleGroups: ["triceps", "shoulders"],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Adjust the seat so the handles line up with the middle of your chest. Push the handles forward until your arms are almost straight, then let them return slowly. Keep your back against the pad and avoid locking your elbows hard at the end.",
  },
  {
    key: "pec_deck_fly",
    name: "Pec deck fly",
    primaryMuscle: "chest",
    muscleGroups: ["shoulders"],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit tall with the handles or pads at chest height and elbows softly bent. Bring your arms together in front of you, squeeze briefly, then open back out with control. Set the start position so your hands stay slightly in front of your body, not behind it.",
  },
  {
    key: "cable_crossover",
    name: "Cable crossover",
    primaryMuscle: "chest",
    muscleGroups: ["shoulders"],
    equipment: "cable",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Set both pulleys high, take a handle in each hand and step forward into a split stance. Sweep your hands down and together in front of your hips, then let them travel back up and out. Keep a fixed bend in the elbows so the chest does the work, not the arms.",
  },
  {
    key: "push_up",
    name: "Push-up",
    primaryMuscle: "chest",
    muscleGroups: ["triceps", "shoulders", "core"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Start in a high plank with hands slightly wider than your shoulders. Bend your elbows to lower your chest close to the floor, then push back up. Keep your body in one straight line from head to heels; do not let the hips sag.",
  },
  {
    key: "incline_push_up",
    name: "Incline push-up",
    primaryMuscle: "chest",
    muscleGroups: ["triceps", "shoulders"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Place your hands on a bench, box or sturdy table edge and walk your feet back. Lower your chest toward the edge and press away until your arms are straight. The higher the surface, the easier the rep, so lower it gradually as you get stronger.",
  },
  {
    key: "chest_dip",
    name: "Chest dip",
    primaryMuscle: "chest",
    muscleGroups: ["triceps", "shoulders"],
    equipment: "other",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Support yourself on parallel bars with straight arms and lean your torso slightly forward. Bend the elbows to lower until your upper arms are about level with the floor, then press back up. Go only as deep as your shoulders stay comfortable.",
  },
  {
    key: "band_chest_press",
    name: "Resistance band chest press",
    primaryMuscle: "chest",
    muscleGroups: ["triceps", "shoulders"],
    equipment: "band",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Wrap a band around a post or your upper back and hold one end in each hand at chest height. Press both hands forward until your arms are straight, then return slowly. Check the band for nicks or tears before each session.",
  },

  // ── Back ───────────────────────────────────────────────────────────────
  {
    key: "conventional_deadlift",
    name: "Conventional deadlift",
    primaryMuscle: "back",
    muscleGroups: ["glutes", "hamstrings", "forearms"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Stand with the bar over your mid-foot, hinge down and grip it just outside your legs. Brace your trunk, push the floor away and stand up tall with the bar close to your shins and thighs. Keep your back flat from start to finish and lower the bar along the same path.",
  },
  {
    key: "barbell_bent_over_row",
    name: "Barbell bent-over row",
    primaryMuscle: "back",
    muscleGroups: ["biceps", "shoulders", "forearms"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Hold the bar with an overhand grip, soften your knees and hinge forward until your torso is well inclined. Pull the bar toward your lower ribs, then lower it until your arms are straight. Hold the hinge steady rather than standing up to heave the weight.",
  },
  {
    key: "t_bar_row",
    name: "T-bar row",
    primaryMuscle: "back",
    muscleGroups: ["biceps", "forearms"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Straddle a barbell anchored in a landmine or corner and grip the handle near the plates. Hinge forward and row the plates toward your chest, then lower until your arms are straight. Keep your chest proud and your neck in line with your spine.",
  },
  {
    key: "one_arm_dumbbell_row",
    name: "One-arm dumbbell row",
    primaryMuscle: "back",
    muscleGroups: ["biceps", "shoulders"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Rest one knee and hand on a bench with your back flat and the dumbbell hanging below your shoulder. Pull it toward your hip, leading with the elbow, then lower it fully. Avoid twisting your torso open to lift heavier.",
  },
  {
    key: "chest_supported_dumbbell_row",
    name: "Chest-supported dumbbell row",
    primaryMuscle: "back",
    muscleGroups: ["biceps", "shoulders"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Lie face down on an incline bench with a dumbbell in each hand hanging straight down. Row both elbows back until the weights reach your sides, pause, then lower. Keep your chest on the pad so your lower back stays out of the movement.",
  },
  {
    key: "lat_pulldown",
    name: "Lat pulldown",
    primaryMuscle: "back",
    muscleGroups: ["biceps", "shoulders"],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit with your thighs under the pad and take a wide overhand grip on the bar. Pull the bar down to your upper chest while leaning back only slightly, then let it rise until your arms are straight. Never pull the bar behind your neck.",
  },
  {
    key: "seated_cable_row",
    name: "Seated cable row",
    primaryMuscle: "back",
    muscleGroups: ["biceps", "shoulders"],
    equipment: "cable",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit with your feet on the platform, knees soft, holding the handle with arms extended. Pull it to your stomach while squeezing your shoulder blades together, then reach forward again. Keep your torso mostly upright instead of rocking back and forth.",
  },
  {
    key: "straight_arm_pulldown",
    name: "Straight-arm cable pulldown",
    primaryMuscle: "back",
    muscleGroups: ["triceps", "core"],
    equipment: "cable",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Face a high pulley holding a straight bar or rope, arms extended and hips hinged slightly. Sweep the bar down in an arc to your thighs while keeping the arms long. Lock your ribs down so the movement comes from the shoulders, not from bending forward.",
  },
  {
    key: "pull_up",
    name: "Pull-up",
    primaryMuscle: "back",
    muscleGroups: ["biceps", "forearms", "core"],
    equipment: "pullup_bar",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Hang from the bar with an overhand grip a bit wider than your shoulders. Pull your chest toward the bar until your chin clears it, then lower to a full hang. Avoid kicking or swinging; use an assisted version until you can do clean reps.",
  },
  {
    key: "chin_up",
    name: "Chin-up",
    primaryMuscle: "back",
    muscleGroups: ["biceps", "forearms"],
    equipment: "pullup_bar",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Hang from the bar with palms facing you and hands about shoulder-width apart. Pull up until your chin is over the bar, then lower slowly to straight arms. Keep your legs still and your stomach tight.",
  },
  {
    key: "assisted_pull_up_machine",
    name: "Assisted pull-up (machine)",
    primaryMuscle: "back",
    muscleGroups: ["biceps"],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Select a counterweight, kneel or stand on the platform and grip the handles overhead. Pull yourself up until your chin passes the handles, then lower with control. Use less assistance over time as your strength improves.",
  },
  {
    key: "inverted_row",
    name: "Inverted row",
    primaryMuscle: "back",
    muscleGroups: ["biceps", "core"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Lie under a bar set at waist height in a rack or Smith machine and grab it with straight arms. Keeping your body rigid, pull your chest up to the bar and lower back down. Bend your knees to make it easier or raise your feet to make it harder.",
  },
  {
    key: "back_extension",
    name: "Back extension",
    primaryMuscle: "back",
    muscleGroups: ["glutes", "hamstrings"],
    equipment: "bench",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Set the hip pad of a back-extension bench just below your hip bones and lock your heels in. Lower your torso forward, then raise it until your body forms a straight line. Stop at straight; do not swing up into an exaggerated arch.",
  },
  {
    key: "superman_hold",
    name: "Superman hold",
    primaryMuscle: "back",
    muscleGroups: ["glutes"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Lie face down with arms stretched overhead. Lift your arms, chest and legs a few centimetres off the floor and hold. Keep your gaze on the floor so your neck stays relaxed.",
  },
  {
    key: "barbell_shrug",
    name: "Barbell shrug",
    primaryMuscle: "back",
    muscleGroups: ["forearms"],
    equipment: "barbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Stand tall holding a barbell at arm's length in front of your thighs. Lift your shoulders straight up toward your ears, pause, then lower them fully. Avoid rolling the shoulders in circles; a straight up-and-down path is enough.",
  },

  // ── Shoulders ─────────────────────────────────────────────────────────
  {
    key: "barbell_overhead_press",
    name: "Barbell overhead press",
    primaryMuscle: "shoulders",
    muscleGroups: ["triceps", "core"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Stand with the bar resting on your front shoulders and hands just outside them. Press it straight up, moving your head back slightly to let it pass, and finish with the bar over your mid-foot. Squeeze your glutes and stomach so your lower back does not overarch.",
  },
  {
    key: "seated_dumbbell_shoulder_press",
    name: "Seated dumbbell shoulder press",
    primaryMuscle: "shoulders",
    muscleGroups: ["triceps"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit on an upright bench with dumbbells at shoulder height, palms facing forward. Press them overhead until your arms are straight, then lower back to shoulder level. Keep your back against the pad and your elbows slightly in front of your body.",
  },
  {
    key: "arnold_press",
    name: "Arnold press",
    primaryMuscle: "shoulders",
    muscleGroups: ["triceps"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Sit holding dumbbells in front of your shoulders with palms facing you. As you press up, rotate your hands so the palms face forward at the top, then reverse the turn on the way down. Use a lighter weight than a regular press while you learn the rotation.",
  },
  {
    key: "machine_shoulder_press",
    name: "Machine shoulder press",
    primaryMuscle: "shoulders",
    muscleGroups: ["triceps"],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Set the seat so the handles start at about shoulder height. Press up until your arms are nearly straight, then lower under control. Keep your head and upper back resting against the pad.",
  },
  {
    key: "dumbbell_lateral_raise",
    name: "Dumbbell lateral raise",
    primaryMuscle: "shoulders",
    muscleGroups: [],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Stand with light dumbbells at your sides and a slight bend in your elbows. Raise your arms out to the sides until they reach shoulder height, then lower slowly. Lead with the elbows and avoid swinging your body to lift the weight.",
  },
  {
    key: "dumbbell_front_raise",
    name: "Dumbbell front raise",
    primaryMuscle: "shoulders",
    muscleGroups: ["chest"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Hold dumbbells in front of your thighs with palms facing down. Lift them forward to shoulder height with nearly straight arms and lower them back. Stand tall and keep the movement smooth rather than using momentum.",
  },
  {
    key: "rear_delt_fly",
    name: "Bent-over rear delt fly",
    primaryMuscle: "shoulders",
    muscleGroups: ["back"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Hinge forward with a flat back, letting light dumbbells hang below your chest. Open your arms out to the sides until they line up with your shoulders, then lower. Think of moving your hands wide rather than squeezing them back.",
  },
  {
    key: "face_pull",
    name: "Cable face pull",
    primaryMuscle: "shoulders",
    muscleGroups: ["back"],
    equipment: "cable",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Set a rope on a pulley at about face height and hold the ends with thumbs pointing back. Pull the rope toward your forehead, spreading your hands apart as your elbows go wide. Use a light weight and pause briefly at the end of each rep.",
  },
  {
    key: "landmine_press",
    name: "Landmine press",
    primaryMuscle: "shoulders",
    muscleGroups: ["chest", "triceps", "core"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Wedge one end of a barbell in a landmine or corner and hold the other end at shoulder height. Press it up and forward until your arm is straight, then bring it back to your shoulder. Brace your stomach so your body does not twist.",
  },
  {
    key: "pike_push_up",
    name: "Pike push-up",
    primaryMuscle: "shoulders",
    muscleGroups: ["triceps", "chest"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Start in a push-up position and walk your feet in so your hips rise into an upside-down V. Bend your elbows to lower the top of your head toward the floor between your hands, then press back up. Move slowly and keep your weight over your hands.",
  },
  {
    key: "kettlebell_halo",
    name: "Kettlebell halo",
    primaryMuscle: "shoulders",
    muscleGroups: ["core"],
    equipment: "kettlebell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Hold a light kettlebell upside down by the horns in front of your chest. Circle it slowly around your head, keeping it close, and switch direction each set. Keep your ribs down and your hips still as the bell travels.",
  },
  {
    key: "band_pull_apart",
    name: "Band pull-apart",
    primaryMuscle: "shoulders",
    muscleGroups: ["back"],
    equipment: "band",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Hold a light band in front of your chest with straight arms and hands shoulder-width apart. Pull the band apart until it touches your chest, then let it come back slowly. Keep your shoulders down and avoid bending the elbows.",
  },

  // ── Biceps ────────────────────────────────────────────────────────────
  {
    key: "barbell_curl",
    name: "Barbell curl",
    primaryMuscle: "biceps",
    muscleGroups: ["forearms"],
    equipment: "barbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Stand holding a barbell with an underhand, shoulder-width grip. Curl it up toward your shoulders, keeping your elbows by your sides, then lower to straight arms. Do not lean back or swing the hips to finish a rep.",
  },
  {
    key: "ez_bar_curl",
    name: "EZ-bar curl",
    primaryMuscle: "biceps",
    muscleGroups: ["forearms"],
    equipment: "barbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Hold an EZ bar on its angled grips with palms facing up. Curl the bar up to chest height and lower it slowly. The angled grip is easier on the wrists, so it suits anyone who finds a straight bar uncomfortable.",
  },
  {
    key: "dumbbell_bicep_curl",
    name: "Dumbbell bicep curl",
    primaryMuscle: "biceps",
    muscleGroups: ["forearms"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Stand with a dumbbell in each hand, palms facing forward. Curl the weights up together or one at a time, then lower them all the way down. Keep your upper arms still and your wrists straight.",
  },
  {
    key: "hammer_curl",
    name: "Hammer curl",
    primaryMuscle: "biceps",
    muscleGroups: ["forearms"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Hold dumbbells at your sides with palms facing your thighs. Curl them up while keeping that neutral grip, then lower slowly. Keep your elbows close to your body rather than letting them drift forward.",
  },
  {
    key: "concentration_curl",
    name: "Concentration curl",
    primaryMuscle: "biceps",
    muscleGroups: [],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit on a bench, lean forward and brace the back of your upper arm against your inner thigh. Curl the dumbbell up toward your shoulder and lower it slowly. Keep the elbow anchored to your leg the whole time.",
  },
  {
    key: "preacher_curl",
    name: "Preacher curl",
    primaryMuscle: "biceps",
    muscleGroups: ["forearms"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Sit at a preacher bench with your upper arms resting flat on the angled pad, holding an EZ bar. Curl the bar up, then lower until your arms are almost straight. Control the bottom of the rep instead of letting the bar drop.",
  },
  {
    key: "cable_bicep_curl",
    name: "Cable bicep curl",
    primaryMuscle: "biceps",
    muscleGroups: ["forearms"],
    equipment: "cable",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Attach a straight bar to a low pulley and stand facing it with an underhand grip. Curl the bar toward your chest, then return to straight arms. Stand far enough back that the cable stays tight at the bottom.",
  },

  // ── Triceps ───────────────────────────────────────────────────────────
  {
    key: "close_grip_bench_press",
    name: "Close-grip bench press",
    primaryMuscle: "triceps",
    muscleGroups: ["chest", "shoulders"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Lie on a flat bench and grip the bar about shoulder-width apart. Lower it to your lower chest with elbows tucked close to your body, then press back up. Avoid a very narrow grip, which puts strain on the wrists.",
  },
  {
    key: "rope_triceps_pushdown",
    name: "Rope triceps pushdown",
    primaryMuscle: "triceps",
    muscleGroups: [],
    equipment: "cable",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Attach a rope to a high pulley and hold the ends with elbows bent at your sides. Push down until your arms are straight, pulling the rope ends slightly apart at the bottom. Keep your elbows fixed by your ribs as the forearms move.",
  },
  {
    key: "overhead_cable_triceps_extension",
    name: "Overhead cable triceps extension",
    primaryMuscle: "triceps",
    muscleGroups: [],
    equipment: "cable",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Face away from a pulley holding a rope behind your head, elbows pointing forward. Straighten your arms out in front of and above your head, then bend them back slowly. Use a staggered stance and keep your ribs from flaring.",
  },
  {
    key: "skull_crusher",
    name: "Skull crusher (lying triceps extension)",
    primaryMuscle: "triceps",
    muscleGroups: [],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Lie on a flat bench holding an EZ bar above your chest with arms straight. Bend only at the elbows to lower the bar toward your forehead, then extend back up. Use a moderate weight and keep your upper arms still.",
  },
  {
    key: "overhead_dumbbell_triceps_extension",
    name: "Overhead dumbbell triceps extension",
    primaryMuscle: "triceps",
    muscleGroups: [],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit or stand holding one dumbbell with both hands above your head. Lower it behind your head by bending the elbows, then press it back up. Keep the elbows pointing forward and close to your head.",
  },
  {
    key: "dumbbell_kickback",
    name: "Dumbbell triceps kickback",
    primaryMuscle: "triceps",
    muscleGroups: [],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Hinge forward with a flat back and hold your upper arm parallel to your torso, elbow bent. Straighten the arm back behind you, pause, then return to the bent position. Choose a light dumbbell so the upper arm stays still.",
  },
  {
    key: "bench_dip",
    name: "Bench dip",
    primaryMuscle: "triceps",
    muscleGroups: ["chest", "shoulders"],
    equipment: "bench",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit on the edge of a bench, place your hands beside your hips and slide your hips off the edge. Bend your elbows to lower your body a short way, then push back up. Keep your back close to the bench and stop before your shoulders roll forward.",
  },
  {
    key: "diamond_push_up",
    name: "Diamond push-up",
    primaryMuscle: "triceps",
    muscleGroups: ["chest", "shoulders"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Set up in a push-up position with your hands close together under your chest, thumbs and index fingers forming a diamond. Lower your chest to your hands and push back up. Drop to your knees if you cannot keep your body straight.",
  },

  // ── Forearms & grip ───────────────────────────────────────────────────
  {
    key: "dumbbell_wrist_curl",
    name: "Dumbbell wrist curl",
    primaryMuscle: "forearms",
    muscleGroups: [],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit with your forearms resting on your thighs or a bench, palms up, wrists just past the edge. Let the dumbbells roll down toward your fingers, then curl your wrists up. Use light weights and a slow, full range.",
  },
  {
    key: "reverse_wrist_curl",
    name: "Reverse wrist curl",
    primaryMuscle: "forearms",
    muscleGroups: [],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Rest your forearms on your thighs with palms facing down, holding light dumbbells. Lift the back of your hands up toward you, then lower slowly. Keep the forearms still so only the wrists move.",
  },
  {
    key: "reverse_barbell_curl",
    name: "Reverse-grip barbell curl",
    primaryMuscle: "forearms",
    muscleGroups: ["biceps"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Hold a barbell or EZ bar with an overhand grip at thigh height. Curl it up toward your shoulders without letting your wrists bend back, then lower. Start lighter than a regular curl, as this grip is much weaker.",
  },
  {
    key: "farmers_walk",
    name: "Farmer's walk",
    primaryMuscle: "forearms",
    muscleGroups: ["back", "core", "shoulders"],
    equipment: "dumbbell",
    measure: "DISTANCE",
    level: "BEGINNER",
    instructions:
      "Pick up a heavy dumbbell in each hand, stand tall and pull your shoulders back. Walk with short, steady steps for the set distance. Set the weights down by bending your knees and hips, not by rounding your back.",
  },
  {
    key: "dead_hang",
    name: "Dead hang",
    primaryMuscle: "forearms",
    muscleGroups: ["back", "shoulders"],
    equipment: "pullup_bar",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Grab a pull-up bar with an overhand grip and let your body hang with arms straight. Hold the position, breathing steadily, for the target time. Step down onto a box rather than dropping when your grip starts to fail.",
  },

  // ── Core ──────────────────────────────────────────────────────────────
  {
    key: "plank",
    name: "Plank",
    primaryMuscle: "core",
    muscleGroups: ["shoulders", "glutes"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Rest on your forearms and toes with elbows under your shoulders. Hold your body in a straight line from head to heels, squeezing your stomach and glutes. End the set when your hips start to sag or rise.",
  },
  {
    key: "side_plank",
    name: "Side plank",
    primaryMuscle: "core",
    muscleGroups: ["shoulders", "glutes"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Lie on your side, prop yourself on one forearm and stack your feet. Lift your hips so your body forms a straight line and hold. Bend the bottom knee to the floor for an easier version, and work both sides.",
  },
  {
    key: "crunch",
    name: "Crunch",
    primaryMuscle: "core",
    muscleGroups: [],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Lie on your back with knees bent and fingertips lightly touching the sides of your head. Curl your shoulders off the floor by tightening your stomach, then lower slowly. Do not pull on your head or neck with your hands.",
  },
  {
    key: "bicycle_crunch",
    name: "Bicycle crunch",
    primaryMuscle: "core",
    muscleGroups: [],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Lie on your back with hands by your head and legs lifted, knees bent. Bring one elbow toward the opposite knee while extending the other leg, then switch sides in a pedalling motion. Go slowly enough that your lower back stays on the floor.",
  },
  {
    key: "lying_leg_raise",
    name: "Lying leg raise",
    primaryMuscle: "core",
    muscleGroups: [],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Lie flat with legs straight and hands under your hips or by your sides. Lift your legs until they point at the ceiling, then lower them slowly without touching the floor. Bend your knees if your lower back lifts off the mat.",
  },
  {
    key: "hanging_knee_raise",
    name: "Hanging knee raise",
    primaryMuscle: "core",
    muscleGroups: ["forearms"],
    equipment: "pullup_bar",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Hang from a pull-up bar with straight arms. Draw your knees up toward your chest by curling your pelvis, then lower them with control. Pause between reps so you do not start swinging.",
  },
  {
    key: "hanging_leg_raise",
    name: "Hanging leg raise",
    primaryMuscle: "core",
    muscleGroups: ["forearms"],
    equipment: "pullup_bar",
    measure: "REPS",
    level: "ADVANCED",
    instructions:
      "Hang from a bar with legs together and straight. Lift your legs in front of you to at least hip height, then lower them slowly. Master the knee-raise version first and keep your body still between reps.",
  },
  {
    key: "russian_twist",
    name: "Russian twist",
    primaryMuscle: "core",
    muscleGroups: [],
    equipment: "medicine_ball",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit with knees bent, lean back slightly and hold a medicine ball at your chest. Rotate your shoulders to one side and then the other, touching the ball beside your hip. Keep your chest lifted and your back straight rather than slumping.",
  },
  {
    key: "mountain_climber",
    name: "Mountain climber",
    primaryMuscle: "core",
    muscleGroups: ["shoulders", "cardio"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Start in a high plank with hands under your shoulders. Drive one knee toward your chest, then swap legs quickly as if running in place. Keep your hips low and level with your shoulders.",
  },
  {
    key: "dead_bug",
    name: "Dead bug",
    primaryMuscle: "core",
    muscleGroups: [],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Lie on your back with arms pointing to the ceiling and knees bent at 90 degrees over your hips. Slowly lower one arm overhead and the opposite leg toward the floor, then return and switch sides. Press your lower back gently into the floor the whole time.",
  },
  {
    key: "bird_dog",
    name: "Bird dog",
    primaryMuscle: "core",
    muscleGroups: ["back", "glutes"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Kneel on all fours with hands under shoulders and knees under hips. Reach one arm forward and the opposite leg back until both are level with your body, then return and switch. Move slowly and keep your hips square to the floor.",
  },
  {
    key: "hollow_body_hold",
    name: "Hollow body hold",
    primaryMuscle: "core",
    muscleGroups: [],
    equipment: "bodyweight",
    measure: "TIME",
    level: "INTERMEDIATE",
    instructions:
      "Lie on your back, press your lower back into the floor and lift your shoulders and straight legs off the ground. Reach your arms past your ears and hold the shallow banana shape. Bend your knees or bring your arms forward if your back starts to arch.",
  },
  {
    key: "cable_crunch",
    name: "Kneeling cable crunch",
    primaryMuscle: "core",
    muscleGroups: [],
    equipment: "cable",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Kneel facing a high pulley and hold a rope beside your head. Curl your chest down toward your knees by rounding through the stomach, then rise back up. Keep your hips still so the bend comes from the trunk, not the hips.",
  },
  {
    key: "pallof_press",
    name: "Pallof press",
    primaryMuscle: "core",
    muscleGroups: ["shoulders"],
    equipment: "band",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Anchor a band at chest height and stand side-on, holding it at your chest with both hands. Press your hands straight out in front and resist the pull that tries to rotate you. Hold for a moment, bring your hands back, and switch sides after the set.",
  },
  {
    key: "ab_wheel_rollout",
    name: "Ab wheel rollout",
    primaryMuscle: "core",
    muscleGroups: ["shoulders", "back"],
    equipment: "other",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Kneel on a mat holding an ab wheel under your shoulders. Roll it forward as far as you can while keeping your back flat, then pull it back to the start. Shorten the range if your lower back begins to sag.",
  },
  {
    key: "decline_sit_up",
    name: "Decline sit-up",
    primaryMuscle: "core",
    muscleGroups: [],
    equipment: "bench",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Secure your feet under the pads of a decline bench and cross your arms on your chest. Lower your back toward the bench, then curl up until your torso is upright. Move steadily and avoid jerking up with your arms.",
  },
  {
    key: "medicine_ball_slam",
    name: "Medicine ball slam",
    primaryMuscle: "core",
    muscleGroups: ["shoulders", "back", "cardio"],
    equipment: "medicine_ball",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Stand with feet shoulder-width apart, holding a non-bouncing slam ball. Lift it overhead, then throw it hard into the floor in front of you while hinging at the hips. Use a ball made for slamming and keep your face clear of any rebound.",
  },

  // ── Quads ─────────────────────────────────────────────────────────────
  {
    key: "barbell_back_squat",
    name: "Barbell back squat",
    primaryMuscle: "quads",
    muscleGroups: ["glutes", "hamstrings", "core"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Rest the bar across your upper back, step out of the rack and set your feet about shoulder-width apart. Sit down between your hips until your thighs are at least parallel, then stand back up. Keep your knees tracking over your toes and set the safety bars before heavy sets.",
  },
  {
    key: "barbell_front_squat",
    name: "Barbell front squat",
    primaryMuscle: "quads",
    muscleGroups: ["glutes", "core"],
    equipment: "barbell",
    measure: "REPS",
    level: "ADVANCED",
    instructions:
      "Rest the bar on the front of your shoulders with elbows pointing forward and high. Squat down keeping your torso upright, then drive back up. If your elbows drop the bar will roll forward, so keep them lifted throughout.",
  },
  {
    key: "goblet_squat",
    name: "Goblet squat",
    primaryMuscle: "quads",
    muscleGroups: ["glutes", "core"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Hold one dumbbell vertically against your chest with both hands. Squat down so your elbows pass inside your knees, then stand up tall. Keep your heels on the floor and your chest upright.",
  },
  {
    key: "bodyweight_squat",
    name: "Bodyweight squat",
    primaryMuscle: "quads",
    muscleGroups: ["glutes"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Stand with feet about shoulder-width apart and arms out in front for balance. Bend your hips and knees to sit down as low as is comfortable, then stand up. Keep your weight spread across your whole foot.",
  },
  {
    key: "leg_press",
    name: "Leg press",
    primaryMuscle: "quads",
    muscleGroups: ["glutes", "hamstrings"],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit in the machine with your feet shoulder-width apart in the middle of the platform. Release the safety, lower the platform until your knees are bent to about 90 degrees, then press it away. Do not lock your knees hard at the top or let your lower back lift off the seat.",
  },
  {
    key: "hack_squat",
    name: "Hack squat (machine)",
    primaryMuscle: "quads",
    muscleGroups: ["glutes"],
    equipment: "machine",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Stand on the platform with your back against the pad and shoulders under the supports. Release the handles, squat down until your thighs are about parallel, then push back up. Keep your whole back in contact with the pad.",
  },
  {
    key: "leg_extension",
    name: "Leg extension",
    primaryMuscle: "quads",
    muscleGroups: [],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit with your knees lined up with the machine's pivot and the pad resting on your lower shins. Straighten your legs, pause briefly at the top and lower slowly. Hold the side handles to keep your hips on the seat.",
  },
  {
    key: "walking_lunge",
    name: "Dumbbell walking lunge",
    primaryMuscle: "quads",
    muscleGroups: ["glutes", "hamstrings"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Hold a dumbbell in each hand and take a long step forward. Lower until both knees are bent at roughly 90 degrees, then push through the front foot to step into the next lunge. Keep your torso upright and your front knee in line with your toes.",
  },
  {
    key: "reverse_lunge",
    name: "Reverse lunge",
    primaryMuscle: "quads",
    muscleGroups: ["glutes"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Stand tall and step one foot back, lowering your back knee toward the floor. Push through your front heel to return to standing, then switch legs. Stepping backward is gentler on the knees than a forward lunge.",
  },
  {
    key: "bulgarian_split_squat",
    name: "Bulgarian split squat",
    primaryMuscle: "quads",
    muscleGroups: ["glutes", "hamstrings"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Stand a stride in front of a bench and rest the top of your back foot on it, holding dumbbells at your sides. Lower your back knee toward the floor, then drive up through the front foot. Find a front-foot position where the front heel stays down at the bottom.",
  },
  {
    key: "bench_step_up",
    name: "Bench step-up",
    primaryMuscle: "quads",
    muscleGroups: ["glutes"],
    equipment: "bench",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Place one whole foot on a sturdy bench or box at about knee height. Push through that foot to stand on top, then step down with control. Use a bench that does not wobble and avoid pushing off the floor with the back leg.",
  },
  {
    key: "wall_sit",
    name: "Wall sit",
    primaryMuscle: "quads",
    muscleGroups: ["glutes"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Lean your back against a wall and walk your feet out until your knees are bent at about 90 degrees. Hold the seated position with your weight in your heels. Rise up a little if you feel strain in the front of the knee.",
  },
  {
    key: "jump_squat",
    name: "Jump squat",
    primaryMuscle: "quads",
    muscleGroups: ["glutes", "calves", "cardio"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Squat down to about half depth with arms back. Jump up explosively, swinging your arms, and land softly with bent knees before going into the next rep. Land quietly on the balls of your feet, then let your heels settle.",
  },

  // ── Hamstrings ────────────────────────────────────────────────────────
  {
    key: "romanian_deadlift",
    name: "Romanian deadlift",
    primaryMuscle: "hamstrings",
    muscleGroups: ["glutes", "back"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Stand holding a barbell at your thighs with knees softly bent. Push your hips back and slide the bar down your legs until you feel a strong stretch in your hamstrings, then drive your hips forward to stand. Keep your back flat; the depth is set by your hamstrings, not by how low the bar goes.",
  },
  {
    key: "dumbbell_romanian_deadlift",
    name: "Dumbbell Romanian deadlift",
    primaryMuscle: "hamstrings",
    muscleGroups: ["glutes", "back"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Hold dumbbells in front of your thighs and soften your knees. Hinge at the hips, lowering the weights along your legs to about mid-shin, then stand back up. Keep the dumbbells close to your legs and your neck neutral.",
  },
  {
    key: "single_leg_romanian_deadlift",
    name: "Single-leg Romanian deadlift",
    primaryMuscle: "hamstrings",
    muscleGroups: ["glutes", "core"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Stand on one leg holding a dumbbell in the opposite hand. Hinge forward as the free leg reaches back, until your torso is close to level, then return to standing. Keep your hips square to the floor and touch a wall for balance if needed.",
  },
  {
    key: "lying_leg_curl",
    name: "Lying leg curl",
    primaryMuscle: "hamstrings",
    muscleGroups: ["calves"],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Lie face down on the machine with the pad just above your heels and knees just off the bench edge. Curl your heels toward your glutes, then lower slowly. Keep your hips pressed into the bench as you curl.",
  },
  {
    key: "seated_leg_curl",
    name: "Seated leg curl",
    primaryMuscle: "hamstrings",
    muscleGroups: ["calves"],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit with the lower pad behind your ankles and the thigh pad locked down over your knees. Pull your heels down and under you, then let them rise back slowly. Align your knees with the machine's pivot point before starting.",
  },
  {
    key: "nordic_hamstring_curl",
    name: "Nordic hamstring curl",
    primaryMuscle: "hamstrings",
    muscleGroups: ["glutes"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "ADVANCED",
    instructions:
      "Kneel on a pad with your ankles held down by a partner or a fixed support. Keeping your hips straight, lean forward as slowly as you can, then catch yourself with your hands and push back up. Work only through the range you can control.",
  },
  {
    key: "kettlebell_deadlift",
    name: "Kettlebell deadlift",
    primaryMuscle: "hamstrings",
    muscleGroups: ["glutes", "back"],
    equipment: "kettlebell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Stand with a kettlebell between your feet. Hinge at the hips, grip the handle with both hands and stand up tall by driving your hips forward. It is a good way to learn the hip hinge before moving to a barbell.",
  },

  // ── Glutes ────────────────────────────────────────────────────────────
  {
    key: "barbell_hip_thrust",
    name: "Barbell hip thrust",
    primaryMuscle: "glutes",
    muscleGroups: ["hamstrings", "core"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Sit with your upper back against a bench and a padded barbell over your hips. Drive through your heels to lift your hips until your body is flat from shoulders to knees, then lower. Tuck your chin slightly and finish with a glute squeeze, not by arching your back.",
  },
  {
    key: "glute_bridge",
    name: "Glute bridge",
    primaryMuscle: "glutes",
    muscleGroups: ["hamstrings"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Lie on your back with knees bent and feet flat, close to your hips. Push through your heels to lift your hips until your body forms a straight line from shoulders to knees, then lower. Keep your ribs down so the lift comes from the hips.",
  },
  {
    key: "single_leg_glute_bridge",
    name: "Single-leg glute bridge",
    primaryMuscle: "glutes",
    muscleGroups: ["hamstrings", "core"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Lie on your back with one foot flat and the other leg extended or hugged to your chest. Press through the planted heel to raise your hips, then lower. Keep your pelvis level so one hip does not drop.",
  },
  {
    key: "sumo_deadlift",
    name: "Sumo deadlift",
    primaryMuscle: "glutes",
    muscleGroups: ["quads", "hamstrings", "back"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Take a wide stance with toes turned out and grip the bar inside your knees. Push your knees out, brace and stand up by pushing the floor apart with your feet. Keep the bar close and your chest up as you lift.",
  },
  {
    key: "dumbbell_sumo_squat",
    name: "Dumbbell sumo squat",
    primaryMuscle: "glutes",
    muscleGroups: ["quads"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Stand with a wide stance and toes turned out, holding one dumbbell between your legs. Squat straight down, keeping your knees pushed out over your toes, then stand. Keep your torso upright throughout.",
  },
  {
    key: "kettlebell_swing",
    name: "Kettlebell swing",
    primaryMuscle: "glutes",
    muscleGroups: ["hamstrings", "core", "back"],
    equipment: "kettlebell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Hike the kettlebell back between your legs from a hip hinge. Snap your hips forward so the bell floats up to chest height, then let it fall back into the next hinge. Power comes from the hips; your arms only guide the bell.",
  },
  {
    key: "cable_glute_kickback",
    name: "Cable glute kickback",
    primaryMuscle: "glutes",
    muscleGroups: ["hamstrings"],
    equipment: "cable",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Strap an ankle cuff to a low pulley and face the machine, holding it for support. Kick your leg straight back, squeezing your glute at the top, then return slowly. Avoid arching your lower back to lift the leg higher.",
  },
  {
    key: "hip_abduction_machine",
    name: "Hip abduction (machine)",
    primaryMuscle: "glutes",
    muscleGroups: [],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit in the machine with the pads against the outside of your knees. Push your knees outward as far as is comfortable, then let them come back in slowly. Sit tall and control the return instead of letting the weights crash.",
  },
  {
    key: "banded_lateral_walk",
    name: "Banded lateral walk",
    primaryMuscle: "glutes",
    muscleGroups: ["quads"],
    equipment: "band",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Place a mini band just above your knees or around your ankles and sit into a quarter squat. Step sideways with one foot, then follow with the other, keeping tension on the band. Keep your toes pointing forward and your knees from caving in.",
  },

  // ── Calves ────────────────────────────────────────────────────────────
  {
    key: "standing_calf_raise",
    name: "Standing calf raise (machine)",
    primaryMuscle: "calves",
    muscleGroups: [],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Stand with the balls of your feet on the platform edge and shoulders under the pads. Rise up onto your toes as high as you can, then lower your heels below the platform for a stretch. Pause at the top and bottom instead of bouncing.",
  },
  {
    key: "seated_calf_raise",
    name: "Seated calf raise",
    primaryMuscle: "calves",
    muscleGroups: [],
    equipment: "machine",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Sit with the pad resting on your lower thighs and the balls of your feet on the footplate. Raise your heels as high as possible, then lower them slowly. Use a full range of motion rather than short, fast reps.",
  },
  {
    key: "leg_press_calf_raise",
    name: "Leg press calf raise",
    primaryMuscle: "calves",
    muscleGroups: [],
    equipment: "machine",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Sit in the leg press with legs straight and only the balls of your feet on the bottom of the platform. Push the platform away by pointing your toes, then let it come back. Keep the safety catches engaged and do not let your feet slip off.",
  },
  {
    key: "single_leg_dumbbell_calf_raise",
    name: "Single-leg dumbbell calf raise",
    primaryMuscle: "calves",
    muscleGroups: [],
    equipment: "dumbbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Stand on one foot on a step, holding a dumbbell in the same-side hand and a rail with the other. Rise up onto your toes and lower your heel below the step. Move slowly and keep your knee straight but not locked.",
  },
  {
    key: "bodyweight_calf_raise",
    name: "Bodyweight calf raise",
    primaryMuscle: "calves",
    muscleGroups: [],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Stand on the edge of a step with your heels hanging off, holding a wall or rail. Rise up onto your toes, then lower your heels below the step. Keep your ankles from rolling outward as you rise.",
  },

  // ── Full body ─────────────────────────────────────────────────────────
  {
    key: "burpee",
    name: "Burpee",
    primaryMuscle: "full_body",
    muscleGroups: ["chest", "quads", "cardio"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "From standing, squat and place your hands on the floor, then jump your feet back into a plank. Bring your feet back under you and jump up with arms overhead. Step back and forward instead of jumping if you need a lower-impact version.",
  },
  {
    key: "barbell_thruster",
    name: "Barbell thruster",
    primaryMuscle: "full_body",
    muscleGroups: ["quads", "shoulders", "glutes"],
    equipment: "barbell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Hold the bar in a front rack on your shoulders and squat down. As you stand, use the drive from your legs to press the bar overhead in one smooth movement. Lower it back to your shoulders before the next squat and keep your elbows high.",
  },
  {
    key: "dumbbell_thruster",
    name: "Dumbbell thruster",
    primaryMuscle: "full_body",
    muscleGroups: ["quads", "shoulders", "glutes"],
    equipment: "dumbbell",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Hold dumbbells at shoulder height and squat down. Stand up quickly and press the weights overhead as your legs straighten. Bring them back to your shoulders under control before squatting again.",
  },
  {
    key: "power_clean",
    name: "Power clean",
    primaryMuscle: "full_body",
    muscleGroups: ["back", "glutes", "hamstrings", "shoulders"],
    equipment: "barbell",
    measure: "REPS",
    level: "ADVANCED",
    instructions:
      "Start as in a deadlift, then pull the bar off the floor and extend your hips explosively as it passes your knees. Pull yourself under the bar and catch it on your front shoulders in a partial squat. Learn this lift with a coach and an empty bar before adding load.",
  },
  {
    key: "kettlebell_clean_and_press",
    name: "Kettlebell clean and press",
    primaryMuscle: "full_body",
    muscleGroups: ["shoulders", "glutes", "core"],
    equipment: "kettlebell",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Swing the kettlebell back between your legs and drive your hips forward to bring it up to rest on your forearm at shoulder height. Press it overhead, then lower it back to the rack and down. Keep your wrist straight so the bell rolls around your hand rather than flipping onto it.",
  },
  {
    key: "turkish_get_up",
    name: "Turkish get-up",
    primaryMuscle: "full_body",
    muscleGroups: ["shoulders", "core", "glutes"],
    equipment: "kettlebell",
    measure: "REPS",
    level: "ADVANCED",
    instructions:
      "Lie on your back holding a kettlebell straight up in one hand. Move step by step from lying to elbow, hand, kneeling and finally standing, keeping the arm vertical, then reverse the steps. Keep your eyes on the bell and practise first with no weight.",
  },
  {
    key: "wall_ball",
    name: "Wall ball",
    primaryMuscle: "full_body",
    muscleGroups: ["quads", "shoulders", "cardio"],
    equipment: "medicine_ball",
    measure: "REPS",
    level: "INTERMEDIATE",
    instructions:
      "Stand facing a wall holding a medicine ball at your chest. Squat down, then drive up and throw the ball to a target above you, catching it as you sink into the next squat. Stand close enough that the ball drops back into your hands.",
  },
  {
    key: "bear_crawl",
    name: "Bear crawl",
    primaryMuscle: "full_body",
    muscleGroups: ["shoulders", "core", "quads"],
    equipment: "bodyweight",
    measure: "DISTANCE",
    level: "BEGINNER",
    instructions:
      "Get on all fours with your knees lifted a few centimetres off the floor. Crawl forward by moving opposite hand and foot together for the set distance. Keep your back flat and your hips low.",
  },
  {
    key: "sled_push",
    name: "Sled push",
    primaryMuscle: "full_body",
    muscleGroups: ["quads", "glutes", "calves", "cardio"],
    equipment: "other",
    measure: "DISTANCE",
    level: "INTERMEDIATE",
    instructions:
      "Grip the sled's upright handles with your body leaning forward at a strong angle. Drive it across the floor with short, powerful steps for the target distance. Keep your back flat and your head in line with your spine.",
  },
  {
    key: "battle_ropes",
    name: "Battle ropes",
    primaryMuscle: "full_body",
    muscleGroups: ["shoulders", "core", "cardio"],
    equipment: "other",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Hold one rope end in each hand and stand in a half squat. Move your arms up and down quickly to send waves along the ropes, alternating or together. Stay in your athletic stance and breathe steadily through the interval.",
  },
  {
    key: "surya_namaskar",
    name: "Surya namaskar (sun salutation)",
    primaryMuscle: "full_body",
    muscleGroups: ["shoulders", "hamstrings", "core"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Flow through the sequence of standing reach, forward fold, lunge, plank, lowering, upward stretch and downward-facing position, then back to standing; one full round counts as one rep. Match each move to a slow breath. Bend your knees in the folds if your hamstrings feel tight.",
  },

  // ── Cardio ────────────────────────────────────────────────────────────
  {
    key: "treadmill_walk",
    name: "Treadmill walk",
    primaryMuscle: "cardio",
    muscleGroups: ["calves", "quads"],
    equipment: "cardio_machine",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Clip the safety key to your clothing and start the belt at a slow pace. Walk at a brisk speed where you can still talk, swinging your arms naturally. Avoid holding the handrails, which changes your posture and reduces the effort.",
  },
  {
    key: "incline_treadmill_walk",
    name: "Incline treadmill walk",
    primaryMuscle: "cardio",
    muscleGroups: ["glutes", "calves", "hamstrings"],
    equipment: "cardio_machine",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Set the treadmill to a moderate walking speed and raise the incline gradually. Walk with an upright posture and full steps through the heel. Lower the speed rather than leaning on the rails if it becomes too hard.",
  },
  {
    key: "treadmill_run",
    name: "Treadmill run",
    primaryMuscle: "cardio",
    muscleGroups: ["quads", "calves", "hamstrings"],
    equipment: "cardio_machine",
    measure: "DISTANCE",
    level: "BEGINNER",
    instructions:
      "Warm up with a few minutes of walking, then raise the speed to a steady running pace. Land with your feet under your hips and keep your shoulders relaxed. Use the safety key and slow down gradually before stepping off.",
  },
  {
    key: "treadmill_sprint_intervals",
    name: "Treadmill sprint intervals",
    primaryMuscle: "cardio",
    muscleGroups: ["quads", "hamstrings", "glutes"],
    equipment: "cardio_machine",
    measure: "TIME",
    level: "ADVANCED",
    instructions:
      "After a thorough warm-up, alternate short fast-running bursts with longer walking or jogging recovery periods. Step onto the side rails while the belt changes speed rather than jumping on a fast belt. Record the total working time for the set.",
  },
  {
    key: "outdoor_run",
    name: "Outdoor run",
    primaryMuscle: "cardio",
    muscleGroups: ["quads", "calves", "hamstrings"],
    equipment: "bodyweight",
    measure: "DISTANCE",
    level: "BEGINNER",
    instructions:
      "Start with a few minutes of easy walking or jogging to warm up. Run at a pace you can keep for the planned distance, with relaxed arms and short, quick steps. Choose a safe, well-lit route and carry water on hot days.",
  },
  {
    key: "stationary_bike",
    name: "Stationary bike",
    primaryMuscle: "cardio",
    muscleGroups: ["quads", "hamstrings", "calves"],
    equipment: "cardio_machine",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Set the seat so your knee is only slightly bent at the bottom of the pedal stroke. Pedal at a steady cadence and adjust the resistance to reach your target effort. Keep your upper body relaxed and avoid rocking side to side.",
  },
  {
    key: "spin_bike_intervals",
    name: "Spin bike intervals",
    primaryMuscle: "cardio",
    muscleGroups: ["quads", "glutes", "hamstrings"],
    equipment: "cardio_machine",
    measure: "TIME",
    level: "INTERMEDIATE",
    instructions:
      "Adjust the seat and handlebars, then warm up at an easy resistance. Alternate hard efforts, seated or standing, with easy recovery spins. Use the resistance knob or brake to slow the flywheel; never take your feet off moving pedals.",
  },
  {
    key: "rowing_machine",
    name: "Rowing machine",
    primaryMuscle: "cardio",
    muscleGroups: ["back", "quads", "biceps"],
    equipment: "cardio_machine",
    measure: "DISTANCE",
    level: "BEGINNER",
    instructions:
      "Strap your feet in, grip the handle and sit tall with your shins vertical. Push with your legs first, then lean back slightly and pull the handle to your lower ribs; reverse the order on the way back. Most of the power should come from the leg drive, not the arms.",
  },
  {
    key: "cross_trainer",
    name: "Cross-trainer (elliptical)",
    primaryMuscle: "cardio",
    muscleGroups: ["quads", "glutes", "shoulders"],
    equipment: "cardio_machine",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Step onto the pedals, hold the moving handles and begin striding smoothly. Push and pull with your arms while your legs move in an oval path, adjusting resistance to your target effort. Keep your whole foot on the pedal and stand upright.",
  },
  {
    key: "stair_climber",
    name: "Stair climber",
    primaryMuscle: "cardio",
    muscleGroups: ["glutes", "quads", "calves"],
    equipment: "cardio_machine",
    measure: "TIME",
    level: "INTERMEDIATE",
    instructions:
      "Step on and choose a slow speed to begin. Climb with your whole foot on each step and your torso upright, resting your hands lightly on the rails only for balance. Lower the speed if you find yourself leaning heavily on the rails.",
  },
  {
    key: "skipping_rope",
    name: "Skipping (jump rope)",
    primaryMuscle: "cardio",
    muscleGroups: ["calves", "shoulders"],
    equipment: "other",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Hold the handles at hip height with the rope behind you. Turn the rope with your wrists and make small, light jumps on the balls of your feet. Skip on a flat, non-slippery floor and keep your jumps low.",
  },
  {
    key: "jumping_jacks",
    name: "Jumping jacks",
    primaryMuscle: "cardio",
    muscleGroups: ["calves", "shoulders"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Stand with feet together and arms at your sides. Jump your feet out wide while raising your arms overhead, then jump back to the start. Land softly with slightly bent knees.",
  },
  {
    key: "high_knees",
    name: "High knees",
    primaryMuscle: "cardio",
    muscleGroups: ["quads", "core"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Run in place, lifting each knee up toward hip height. Pump your arms in rhythm with your legs and stay on the balls of your feet. Keep your chest up rather than leaning back.",
  },
  {
    key: "shadow_boxing",
    name: "Shadow boxing",
    primaryMuscle: "cardio",
    muscleGroups: ["shoulders", "core"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Stand in a staggered stance with hands up by your face. Throw light combinations of punches in the air while moving your feet, returning your hands to guard after each punch. Avoid fully locking your elbows at the end of a punch.",
  },

  // ── Mobility & stretching ─────────────────────────────────────────────
  {
    key: "cat_cow",
    name: "Cat-cow",
    primaryMuscle: "back",
    muscleGroups: ["core"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Kneel on all fours with hands under shoulders and knees under hips. Slowly round your back toward the ceiling, then let your belly drop and lift your chest, moving with your breath. Stay in a range that feels comfortable and smooth.",
  },
  {
    key: "childs_pose",
    name: "Child's pose",
    primaryMuscle: "back",
    muscleGroups: ["shoulders", "glutes"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Kneel and sit your hips back toward your heels. Walk your hands forward and rest your forehead on the floor or a cushion, breathing slowly. Widen your knees if your hips or stomach feel crowded.",
  },
  {
    key: "cobra_stretch",
    name: "Cobra stretch",
    primaryMuscle: "core",
    muscleGroups: ["back"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Lie face down with your hands under your shoulders. Gently press your chest up while keeping your hips on the floor and your shoulders away from your ears. Lift only as high as feels easy and hold.",
  },
  {
    key: "downward_dog",
    name: "Downward-facing dog",
    primaryMuscle: "hamstrings",
    muscleGroups: ["calves", "shoulders", "back"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "From all fours, tuck your toes and lift your hips up and back into an upside-down V. Push the floor away with your hands and let your heels sink toward the floor. Keep a slight bend in your knees if your back starts to round.",
  },
  {
    key: "standing_hamstring_stretch",
    name: "Standing hamstring stretch",
    primaryMuscle: "hamstrings",
    muscleGroups: ["calves"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Place one heel on a low step or bench with the leg straight and toes pointing up. Hinge forward from the hips with a long back until you feel a stretch behind the thigh, and hold. Breathe slowly and avoid bouncing.",
  },
  {
    key: "kneeling_hip_flexor_stretch",
    name: "Kneeling hip flexor stretch",
    primaryMuscle: "quads",
    muscleGroups: ["glutes"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Kneel on one knee on a mat with the other foot flat in front of you. Squeeze the glute of the kneeling leg and shift your hips forward slightly until you feel a stretch at the front of the hip. Keep your torso upright and switch sides after the hold.",
  },
  {
    key: "pigeon_stretch",
    name: "Pigeon stretch",
    primaryMuscle: "glutes",
    muscleGroups: ["quads"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "INTERMEDIATE",
    instructions:
      "From all fours, bring one knee forward behind your wrist and slide the other leg straight back. Lower your hips toward the floor and fold forward if comfortable, then hold. Place a cushion under your hip if it does not reach the floor.",
  },
  {
    key: "deep_squat_hold",
    name: "Deep squat hold (malasana)",
    primaryMuscle: "glutes",
    muscleGroups: ["quads", "calves"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Stand with feet a little wider than your hips and toes turned out. Sink into a deep squat with your elbows pressing gently against your inner knees, and hold. Rest your heels on a folded towel if they lift off the floor.",
  },
  {
    key: "doorway_chest_stretch",
    name: "Doorway chest stretch",
    primaryMuscle: "chest",
    muscleGroups: ["shoulders"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Stand in a doorway with your forearms on the frame and elbows at shoulder height. Step one foot through and lean forward gently until you feel a stretch across the chest. Keep your neck relaxed and do not force the shoulders back.",
  },
  {
    key: "cross_body_shoulder_stretch",
    name: "Cross-body shoulder stretch",
    primaryMuscle: "shoulders",
    muscleGroups: ["back"],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Bring one straight arm across your chest. Use your other hand to draw it gently closer at the upper arm, not the elbow, and hold. Keep your shoulders level and switch sides.",
  },
  {
    key: "wall_calf_stretch",
    name: "Wall calf stretch",
    primaryMuscle: "calves",
    muscleGroups: [],
    equipment: "bodyweight",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Face a wall with your hands on it and step one foot back, keeping that leg straight. Press the back heel into the floor and lean in until you feel a stretch in the calf, then hold. Point both feet straight ahead.",
  },
  {
    key: "worlds_greatest_stretch",
    name: "World's greatest stretch",
    primaryMuscle: "full_body",
    muscleGroups: ["glutes", "hamstrings", "back"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Step into a long lunge and place both hands on the floor inside the front foot. Rotate your torso and reach the inside arm toward the ceiling, then return it and straighten the front leg for a moment before switching sides. Move slowly and breathe through each position.",
  },
  {
    key: "open_book_rotation",
    name: "Open book rotation",
    primaryMuscle: "back",
    muscleGroups: ["chest", "shoulders"],
    equipment: "bodyweight",
    measure: "REPS",
    level: "BEGINNER",
    instructions:
      "Lie on your side with knees bent in front of you and arms stretched forward together. Sweep the top arm up and over to the other side, following it with your eyes, then bring it back. Keep your knees stacked so the twist comes from your upper back.",
  },
  {
    key: "foam_roll_upper_back",
    name: "Foam roll upper back",
    primaryMuscle: "back",
    muscleGroups: ["shoulders"],
    equipment: "other",
    measure: "TIME",
    level: "BEGINNER",
    instructions:
      "Lie with a foam roller across your upper back, hands supporting your head and hips on the floor. Lift your hips slightly and roll slowly between your shoulder blades and mid-back. Keep the roller off your neck and lower back.",
  },
];
