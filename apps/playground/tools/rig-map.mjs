/**
 * Skeleton maps for `retarget.mjs`.
 *
 * A map is pure DATA — bone-name correspondences plus the aim chain used to
 * reconcile two rigs' REST poses. Adding support for a new rig pair means
 * adding an entry here, never touching the retarget math.
 *
 * `bones` maps TARGET bone name -> SOURCE bone name. Every target bone left
 * out keeps its rest pose (twist bones, share bones, face rig, toes) — that's
 * deliberate, not an omission: a twist bone driven by nothing looks far better
 * than one driven by a bone it doesn't correspond to.
 *
 * `aim` maps TARGET bone -> the target bone it points AT. This is what lets a
 * T-posed animation library drive an A-posed character: the retargeter poses
 * the target rig into the source's rest pose by aligning each of these
 * directions, and measures every animation frame as a delta from THAT, not
 * from the raw bind pose. Without it a T-pose source on an A-pose target
 * leaves the arms pinned to the character's sides for every clip.
 *
 * An aim may list several candidates; the first bone PRESENT wins. That is how
 * one map covers auto-rigs of differing completeness — a hand aims down its
 * MIDDLE finger where there is one and falls back to the index on a reduced
 * rig carrying only index and thumb. Worth knowing when a character's hands
 * look subtly wrong: that fallback aim is off-centre, so hand roll comes out
 * measurably better on an export that includes the full set of digits.
 */

/**
 * Reallusion Character Creator / AccuRig (`CC_Base_*`) driven by the Unreal
 * Engine mannequin rig (`pelvis`/`spine_01`/`upperarm_l`), which is what the
 * ActorCore-style FBX animation libraries ship on.
 *
 * Every digit the UE rig animates is mapped here, under both the `Mid`
 * spelling Character Creator uses and the `Middle` one, so the map covers a
 * full-hand AccuRig export as well as a reduced one. A rig missing some of
 * them is not an error — the retargeter reports what it could not resolve and
 * those bones simply hold their bind pose.
 */
export const ccBaseFromUeMannequin = {
  id: "cc-base<-ue-mannequin",
  /** Bone whose translation carries the body: the one bone we transfer position for. */
  hip: "CC_Base_Hip",
  /** Used to measure each rig's scale so hip translation transfers in proportion. */
  measure: { top: "CC_Base_Head", bottom: "CC_Base_L_Foot" },
  sourceMeasure: { top: "Head", bottom: "foot_l" },
  /** Bones that touch the ground — how a clip's authored travel speed is read back. */
  contacts: ["CC_Base_L_ToeBase", "CC_Base_R_ToeBase"],
  bones: {
    CC_Base_Hip: "pelvis",
    CC_Base_Waist: "spine_01",
    CC_Base_Spine01: "spine_02",
    CC_Base_Spine02: "spine_03",
    CC_Base_NeckTwist01: "neck_01",
    CC_Base_Head: "Head",

    CC_Base_L_Clavicle: "clavicle_l",
    CC_Base_L_Upperarm: "upperarm_l",
    CC_Base_L_Forearm: "lowerarm_l",
    CC_Base_L_Hand: "hand_l",
    CC_Base_R_Clavicle: "clavicle_r",
    CC_Base_R_Upperarm: "upperarm_r",
    CC_Base_R_Forearm: "lowerarm_r",
    CC_Base_R_Hand: "hand_r",

    CC_Base_L_Thigh: "thigh_l",
    CC_Base_L_Calf: "calf_l",
    CC_Base_L_Foot: "foot_l",
    CC_Base_L_ToeBase: "ball_l",
    CC_Base_R_Thigh: "thigh_r",
    CC_Base_R_Calf: "calf_r",
    CC_Base_R_Foot: "foot_r",
    CC_Base_R_ToeBase: "ball_r",

    CC_Base_L_Index1: "index_01_l",
    CC_Base_L_Index2: "index_02_l",
    CC_Base_L_Index3: "index_03_l",
    CC_Base_L_Mid1: "middle_01_l",
    CC_Base_L_Mid2: "middle_02_l",
    CC_Base_L_Mid3: "middle_03_l",
    CC_Base_L_Middle1: "middle_01_l",
    CC_Base_L_Middle2: "middle_02_l",
    CC_Base_L_Middle3: "middle_03_l",
    CC_Base_L_Ring1: "ring_01_l",
    CC_Base_L_Ring2: "ring_02_l",
    CC_Base_L_Ring3: "ring_03_l",
    CC_Base_L_Pinky1: "pinky_01_l",
    CC_Base_L_Pinky2: "pinky_02_l",
    CC_Base_L_Pinky3: "pinky_03_l",
    CC_Base_L_Thumb1: "thumb_01_l",
    CC_Base_L_Thumb2: "thumb_02_l",
    CC_Base_L_Thumb3: "thumb_03_l",
    CC_Base_R_Index1: "index_01_r",
    CC_Base_R_Index2: "index_02_r",
    CC_Base_R_Index3: "index_03_r",
    CC_Base_R_Mid1: "middle_01_r",
    CC_Base_R_Mid2: "middle_02_r",
    CC_Base_R_Mid3: "middle_03_r",
    CC_Base_R_Middle1: "middle_01_r",
    CC_Base_R_Middle2: "middle_02_r",
    CC_Base_R_Middle3: "middle_03_r",
    CC_Base_R_Ring1: "ring_01_r",
    CC_Base_R_Ring2: "ring_02_r",
    CC_Base_R_Ring3: "ring_03_r",
    CC_Base_R_Pinky1: "pinky_01_r",
    CC_Base_R_Pinky2: "pinky_02_r",
    CC_Base_R_Pinky3: "pinky_03_r",
    CC_Base_R_Thumb1: "thumb_01_r",
    CC_Base_R_Thumb2: "thumb_02_r",
    CC_Base_R_Thumb3: "thumb_03_r",
  },
  aim: {
    CC_Base_Hip: "CC_Base_Waist",
    CC_Base_Waist: "CC_Base_Spine01",
    CC_Base_Spine01: "CC_Base_Spine02",
    CC_Base_Spine02: "CC_Base_NeckTwist01",
    CC_Base_NeckTwist01: "CC_Base_Head",

    CC_Base_L_Clavicle: "CC_Base_L_Upperarm",
    CC_Base_L_Upperarm: "CC_Base_L_Forearm",
    CC_Base_L_Forearm: "CC_Base_L_Hand",
    CC_Base_L_Hand: ["CC_Base_L_Mid1", "CC_Base_L_Middle1", "CC_Base_L_Index1"],
    CC_Base_R_Clavicle: "CC_Base_R_Upperarm",
    CC_Base_R_Upperarm: "CC_Base_R_Forearm",
    CC_Base_R_Forearm: "CC_Base_R_Hand",
    CC_Base_R_Hand: ["CC_Base_R_Mid1", "CC_Base_R_Middle1", "CC_Base_R_Index1"],

    CC_Base_L_Thigh: "CC_Base_L_Calf",
    CC_Base_L_Calf: "CC_Base_L_Foot",
    CC_Base_L_Foot: "CC_Base_L_ToeBase",
    CC_Base_R_Thigh: "CC_Base_R_Calf",
    CC_Base_R_Calf: "CC_Base_R_Foot",
    CC_Base_R_Foot: "CC_Base_R_ToeBase",

    CC_Base_L_Index1: "CC_Base_L_Index2",
    CC_Base_L_Index2: "CC_Base_L_Index3",
    CC_Base_L_Mid1: "CC_Base_L_Mid2",
    CC_Base_L_Mid2: "CC_Base_L_Mid3",
    CC_Base_L_Middle1: "CC_Base_L_Middle2",
    CC_Base_L_Middle2: "CC_Base_L_Middle3",
    CC_Base_L_Ring1: "CC_Base_L_Ring2",
    CC_Base_L_Ring2: "CC_Base_L_Ring3",
    CC_Base_L_Pinky1: "CC_Base_L_Pinky2",
    CC_Base_L_Pinky2: "CC_Base_L_Pinky3",
    CC_Base_L_Thumb1: "CC_Base_L_Thumb2",
    CC_Base_L_Thumb2: "CC_Base_L_Thumb3",
    CC_Base_R_Index1: "CC_Base_R_Index2",
    CC_Base_R_Index2: "CC_Base_R_Index3",
    CC_Base_R_Mid1: "CC_Base_R_Mid2",
    CC_Base_R_Mid2: "CC_Base_R_Mid3",
    CC_Base_R_Middle1: "CC_Base_R_Middle2",
    CC_Base_R_Middle2: "CC_Base_R_Middle3",
    CC_Base_R_Ring1: "CC_Base_R_Ring2",
    CC_Base_R_Ring2: "CC_Base_R_Ring3",
    CC_Base_R_Pinky1: "CC_Base_R_Pinky2",
    CC_Base_R_Pinky2: "CC_Base_R_Pinky3",
    CC_Base_R_Thumb1: "CC_Base_R_Thumb2",
    CC_Base_R_Thumb2: "CC_Base_R_Thumb3",
  },
};

/**
 * Character Creator / AccuRig driven by the MIXAMO rig (`mixamorig:Hips`,
 * sanitized to `mixamorigHips` on load). Mixamo downloads come one clip per
 * FBX, usually skinless, all on the same true T-pose rest — so they bake beside
 * the UE-mannequin libraries in one run, each clip measured against its own
 * source skeleton (retarget picks the map per file by bone names).
 *
 * Mixamo has three spine bones to the mannequin's three, one neck, and no
 * twist bones; digits 1-3 map straight across (the `4`s are end effectors).
 * The aim chain is the target side and is identical to the mannequin map's.
 */
const mixamoDigits = (side, cc) =>
  Object.fromEntries(
    ["Index", "Middle", "Ring", "Pinky", "Thumb"].flatMap((d) =>
      [1, 2, 3].flatMap((i) => {
        const src = `mixamorig${side}Hand${d}${i}`;
        // Character Creator spells the middle finger both ways across exports
        return d === "Middle"
          ? [[`CC_Base_${cc}_Mid${i}`, src], [`CC_Base_${cc}_Middle${i}`, src]]
          : [[`CC_Base_${cc}_${d}${i}`, src]];
      }),
    ),
  );

export const ccBaseFromMixamo = {
  id: "cc-base<-mixamo",
  hip: "CC_Base_Hip",
  measure: { top: "CC_Base_Head", bottom: "CC_Base_L_Foot" },
  sourceMeasure: { top: "mixamorigHead", bottom: "mixamorigLeftFoot" },
  contacts: ["CC_Base_L_ToeBase", "CC_Base_R_ToeBase"],
  bones: {
    CC_Base_Hip: "mixamorigHips",
    CC_Base_Waist: "mixamorigSpine",
    CC_Base_Spine01: "mixamorigSpine1",
    CC_Base_Spine02: "mixamorigSpine2",
    CC_Base_NeckTwist01: "mixamorigNeck",
    CC_Base_Head: "mixamorigHead",

    CC_Base_L_Clavicle: "mixamorigLeftShoulder",
    CC_Base_L_Upperarm: "mixamorigLeftArm",
    CC_Base_L_Forearm: "mixamorigLeftForeArm",
    CC_Base_L_Hand: "mixamorigLeftHand",
    CC_Base_R_Clavicle: "mixamorigRightShoulder",
    CC_Base_R_Upperarm: "mixamorigRightArm",
    CC_Base_R_Forearm: "mixamorigRightForeArm",
    CC_Base_R_Hand: "mixamorigRightHand",

    CC_Base_L_Thigh: "mixamorigLeftUpLeg",
    CC_Base_L_Calf: "mixamorigLeftLeg",
    CC_Base_L_Foot: "mixamorigLeftFoot",
    CC_Base_L_ToeBase: "mixamorigLeftToeBase",
    CC_Base_R_Thigh: "mixamorigRightUpLeg",
    CC_Base_R_Calf: "mixamorigRightLeg",
    CC_Base_R_Foot: "mixamorigRightFoot",
    CC_Base_R_ToeBase: "mixamorigRightToeBase",

    ...mixamoDigits("Left", "L"),
    ...mixamoDigits("Right", "R"),
  },
  aim: ccBaseFromUeMannequin.aim,
};

export const RIG_MAPS = {
  "cc-base<-ue-mannequin": ccBaseFromUeMannequin,
  "cc-base<-mixamo": ccBaseFromMixamo,
};

/**
 * The map a source file needs, by the bones it has: the one whose source
 * names it carries most of. Several libraries on different rigs bake in one
 * run this way, with no per-file flag.
 */
export function detectRigMap(sourceBoneNames, maps = Object.values(RIG_MAPS)) {
  let best = null;
  let bestHits = 0;
  for (const map of maps) {
    const wanted = new Set(Object.values(map.bones));
    let hits = 0;
    for (const n of wanted) if (sourceBoneNames.has(n)) hits++;
    if (hits > bestHits) {
      best = map;
      bestHits = hits;
    }
  }
  return best;
}

/**
 * Clip presets: OUTPUT name <- source clip name. The output names are the
 * vocabulary the `third-person-controller` script expects, so a character
 * exported with the `locomotion` preset drops straight into a scene with no
 * per-clip wiring.
 */
export const CLIP_PRESETS = {
  locomotion: {
    Idle: "Armature|Idle_Loop",
    Idle_LookAround: "Armature|Idle_LookAround_Loop",
    Idle_Tired: "Armature|Idle_Tired_Loop",
    Walk: "Armature|Walk_Loop",
    Walk_Formal: "Armature|Walk_Formal_Loop",
    Run: "Armature|Jog_Fwd_Loop",
    Run_Bwd: "Armature|Jog_Bwd_Loop",
    Run_Left: "Armature|Jog_Left_Loop",
    Run_Right: "Armature|Jog_Right_Loop",
    Sprint: "Armature|Sprint_Loop",
    Sprint_Enter: "Armature|Sprint_Enter",
    Sprint_Exit: "Armature|Sprint_Exit",
    Jump_Start: "Armature|Jump_Start",
    Jump_Loop: "Armature|Jump_Loop",
    Jump_Land: "Armature|Jump_Land",
    Turn_L: "Armature|Turn90_L",
    Turn_R: "Armature|Turn90_R",
    Crouch_Idle: "Armature|Crouch_Idle_Loop",
    Crouch_Fwd: "Armature|Crouch_Fwd_Loop",
    // Swimming: the two names the controller's `swimClip` / `swimIdleClip`
    // default to, so a character baked with this preset swims without being
    // told how. Without them the stroke falls back to the run cycle tipped
    // onto its face, which reads as a crawl but is plainly a stand-in.
    Swim: "Armature|Swim_Fwd_Loop",
    Tread_Water: "Armature|Swim_Idle_Loop",
  },

  /**
   * Combat vocabulary. Names are what the ability system reads out of an
   * ability document's `anim` fields, so a new weapon/spell is a data edit
   * rather than a code change. Unarmed jab->cross->kick is the basic-attack
   * chain; Spell_Simple_* is a cast, Spell_Double_* a channel (its
   * `Channel_Loop` is the sustained beam pose).
   */
  combat: {
    Combat_Enter: "Armature|PunchKick_Enter",
    Combat_Exit: "Armature|PunchKick_Exit",
    Attack1: "Armature|Punch_Jab",
    Attack2: "Armature|Punch_Cross",
    Attack3: "Armature|Kick",
    Sword_Idle: "Armature|Sword_Idle",
    Sword_Enter: "Armature|Sword_Enter",
    Sword_Exit: "Armature|Sword_Exit",
    Sword_Attack: "Armature|Sword_Attack",
    Sword_Attack_Standing: "Armature|Sword_Attack_Standing",
    Cast_Enter: "Armature|Spell_Simple_Enter",
    Cast_Idle: "Armature|Spell_Simple_Idle_Loop",
    Cast_Shoot: "Armature|Spell_Simple_Shoot",
    Cast_Exit: "Armature|Spell_Simple_Exit",
    Channel_Enter: "Armature|Spell_Double_Enter",
    Channel_Idle: "Armature|Spell_Double_Idle_Loop",
    Channel_Loop: "Armature|Spell_Double_Shoot_Loop",
    Channel_Exit: "Armature|Spell_Double_Exit",
    Dodge_L: "Armature|Dodge_Left",
    Dodge_R: "Armature|Dodge_Right",
    Roll: "Armature|Roll",
    Hit_Chest: "Armature|Hit_Chest",
    Hit_Head: "Armature|Hit_Head",
    Hit_Shoulder_L: "Armature|Hit_Shoulder_L",
    Hit_Shoulder_R: "Armature|Hit_Shoulder_R",
    Hit_Stomach: "Armature|Hit_Stomach",
    Death: "Armature|Death01",
    Death_Alt: "Armature|Death02",
  },

  /**
   * Universal Animation Library **2** — an expansion on the same rig, not a
   * replacement, so it is baked alongside UAL1 rather than instead of it:
   *
   *   retarget --anim UAL1.fbx --anim UAL2.fbx --clips locomotion+combat+ual2
   *
   * The sword set is the interesting half. UAL1 has one swing; this has a
   * three-hit combo with recoveries, a heavy finisher, a block and a dash —
   * i.e. the vocabulary the defensive layer (guard / parry / dodge) already
   * resolves against, which until now had no poses of its own.
   */
  ual2: {
    // sword: a chain with recoveries, so a combo can be interrupted on the
    // recovery rather than only between swings
    Sword_A: "Armature|Sword_Regular_A",
    Sword_A_Rec: "Armature|Sword_Regular_A_Rec",
    Sword_B: "Armature|Sword_Regular_B",
    Sword_B_Rec: "Armature|Sword_Regular_B_Rec",
    Sword_C: "Armature|Sword_Regular_C",
    Sword_Combo: "Armature|Sword_Regular_Combo",
    Sword_Heavy: "Armature|Sword_Heavy_Combo",
    Sword_Block: "Armature|Sword_Block",
    Sword_Dash: "Armature|Sword_Dash",
    // shield
    Shield_Idle: "Armature|Idle_Shield_Loop",
    Shield_Break: "Armature|Idle_Shield_Break",
    Shield_Dash: "Armature|Shield_Dash",
    Shield_Bash: "Armature|Shield_OneShot",
    // taking a hit hard enough to move you
    Hit_Knockback: "Armature|Hit_Knockback",
    // movement the engine has no clips for yet
    Slide_Start: "Armature|Slide_Start",
    Slide_Loop: "Armature|Slide_Loop",
    Slide_Exit: "Armature|Slide_Exit",
    Climb_1m: "Armature|ClimbUp_1m",
    Leap_Start: "Armature|NinjaJump_Start",
    Leap_Loop: "Armature|NinjaJump_Idle_Loop",
    Leap_Land: "Armature|NinjaJump_Land",
    Walk_Carry: "Armature|Walk_Carry_Loop",
    Stand_Up: "Armature|LayToIdle",
    // interactions a world needs before it needs another attack
    Chest_Open: "Armature|Chest_Open",
    Consume: "Armature|Consume",
    Harvest: "Armature|Farm_Harvest",
    Plant: "Armature|Farm_PlantSeed",
    Water: "Armature|Farm_Watering",
    Chop: "Armature|TreeChopping_Loop",
    Throw: "Armature|OverhandThrow",
    Punch_Hook: "Armature|Melee_Hook",
    Punch_Hook_Rec: "Armature|Melee_Hook_Rec",
    // idles that say something
    Idle_FoldArms: "Armature|Idle_FoldArms_Loop",
    Idle_Lantern: "Armature|Idle_Lantern_Loop",
    Idle_Lean: "Armature|Idle_Rail_Loop",
    Idle_Lean_Call: "Armature|Idle_Rail_Call",
    Emote_Yes: "Armature|Yes",
    Emote_No: "Armature|Idle_No_Loop",
  },

  /**
   * WEAPON STANCES: `<Stance>_<clip>`, which the third-person-controller plays
   * in place of `<clip>` while an item with that stance is held (see the
   * `weapon-stance` script and the item schema's `stance`). A stance only
   * needs the clips that DIFFER — anything missing falls through the item's
   * stance list, then to the plain clip — so a greataxe (["Axe2H",
   * "TwoHanded"]) is a handful of axe attacks over the shared two-handed set.
   *
   * Sources: UAL1/UAL2 plus Mixamo's Great Sword and (Lite) Sword and Shield
   * packs and four torch swings, one clip per FBX, named after the file:
   *
   *   retarget --anim UAL1.fbx --anim UAL2.fbx --anim mixamo/swordshield \
   *     --anim mixamo/greatsword --anim mixamo/torch --anim mixamo/staff \
   *     --clips locomotion+combat+ual2+weapons
   *
   * Attack trims put the hit (peak speed of the weapon hand, measured) about
   * half-way through the clip, because the caster fits an attack clip to its
   * windup + recovery and the hit lands at the end of the windup. Directions
   * were measured too: Mixamo's "(2)" is the LEFT turn in both packs.
   */
  weapons: {
    // the plain versions of the moments a stance dresses, for empty hands
    Heavy: "Armature|Sword_Attack",
    Block: "Armature|Idle_Shield_Loop",
    Block_Hit: "Armature|Sword_Block@0.15-1.23",
    // holstering (weapon-stance): every stance falls back to these
    Draw: "draw sword 1",
    Sheathe: "sheath sword 1",

    // one-handed sword, no shield (UAL: a fast, snappy chain)
    Sword_Idle: "Armature|Sword_Idle",
    Sword_Attack1: "Armature|Sword_Regular_A",
    Sword_Attack2: "Armature|Sword_Regular_B",
    Sword_Attack3: "Armature|Sword_Regular_C@0.35-0.95",
    Sword_Heavy: "Armature|Sword_Attack@0-0.62",
    Sword_Block: "Armature|Sword_Block@0.15-1.23",

    // sword and board (Mixamo lite pack + UAL2's shield work)
    SwordShield_Idle: "sword and shield idle",
    // no run/strafe of its own: the Mixamo pack's shield-up run read as a
    // different character from the one that walks around (Derek, 2026-09-23),
    // so movement stays the plain library's even in a fight
    SwordShield_Turn_L: "sword and shield turn (2)",
    SwordShield_Turn_R: "sword and shield turn",
    SwordShield_Attack1: "sword and shield attack (4)@0.12-0.8",
    SwordShield_Attack2: "Armature|Sword_Regular_B",
    SwordShield_Attack3: "sword and shield attack (3)@0.4-1.1",
    SwordShield_Heavy: "sword and shield attack (2)@0.1-0.95",
    SwordShield_Bash: "Armature|Shield_OneShot",
    SwordShield_Block: "sword and shield block idle",
    SwordShield_Block_Hit: "sword and shield block (2)",
    SwordShield_Death: "sword and shield death",
    SwordShield_Draw: "draw sword 1",
    SwordShield_Sheathe: "sheath sword 1",

    // every two-handed weapon: movement, guard, hits, death
    TwoHanded_Idle: "great sword idle",
    TwoHanded_Walk: "great sword walk",
    TwoHanded_Run: "great sword run",
    TwoHanded_Sprint: "great sword run (2)",
    TwoHanded_Run_Bwd: "great sword walk (2)",
    TwoHanded_Run_Left: "great sword strafe (3)",
    TwoHanded_Run_Right: "great sword strafe (4)",
    TwoHanded_Turn_L: "great sword turn (2)",
    TwoHanded_Turn_R: "great sword turn",
    TwoHanded_Block: "great sword blocking (2)",
    TwoHanded_Block_Hit: "great sword impact",
    TwoHanded_Hit_Chest: "great sword impact (2)",
    TwoHanded_Hit_Head: "great sword impact (3)",
    TwoHanded_Death: "two handed sword death",
    TwoHanded_Death_Alt: "two handed sword death (2)",
    TwoHanded_Draw: "draw a great sword 1",
    TwoHanded_Cast_Shoot: "great sword casting@1.9-2.8",

    // greatsword: wide slashes, a kick in the chain, a spinning finisher
    GreatSword_Attack1: "great sword slash@0.22-1.17",
    GreatSword_Attack2: "great sword slash (3)@0.4-1.25",
    GreatSword_Attack3: "great sword slash (4)@0.3-1.15",
    GreatSword_Attack4: "great sword kick@0.6-1.5",
    GreatSword_Heavy: "great sword high spin attack@0.2-1.6",

    // greataxe: same body, different arm — chops first, a leaping finisher,
    // and its own idle so the two do not stand alike
    Axe2H_Idle: "great sword idle (3)",
    Axe2H_Attack1: "great sword slash (4)@0.3-1.15",
    Axe2H_Attack2: "great sword attack@0-0.9",
    Axe2H_Attack3: "great sword slash (3)@0.4-1.25",
    Axe2H_Heavy: "great sword jump attack@0.3-1.9",

    // staff: Mixamo's torch swings, MIRRORED into the right hand, and a smash
    Staff_Attack1: "Standing Torch Melee Attack 01@mirror@0.55-1.4",
    Staff_Attack2: "Standing Torch Melee Attack 05@mirror@0.35-1.1",
    Staff_Attack3: "Standing Torch Melee Attack Stab@mirror@0.4-1.25",
    Staff_Attack4: "Standing Torch Melee Attack 03@mirror@1.25-2.1",
    Staff_Heavy: "Smash@0.3-1.6",
    Staff_Cast_Shoot: "spell cast@0-0.7",

    // crossbow: a STOPGAP on the pistol set (two hands forward, a trigger, a
    // reload) until a real crossbow/rifle pack is baked in
    Crossbow_Idle: "Armature|Pistol_Idle_Loop",
    Crossbow_Attack1: "Armature|Pistol_Shoot",
    Crossbow_Reload: "Armature|Pistol_Reload",
  },

  /**
   * The zombie set from UAL2, as a MOB vocabulary: baked onto an undead
   * humanoid it is a complete shambler, and it deliberately reuses the
   * locomotion names (`Idle`, `Walk`) so a mob brain needs no special casing.
   */
  undead: {
    Idle: "Armature|Zombie_Idle_Loop",
    Walk: "Armature|Zombie_Walk_Fwd_Loop",
    Run: "Armature|Zombie_Walk_Fwd_Loop",
    Attack1: "Armature|Zombie_Scratch",
  },
};
