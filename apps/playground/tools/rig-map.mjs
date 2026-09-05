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

export const RIG_MAPS = {
  "cc-base<-ue-mannequin": ccBaseFromUeMannequin,
};

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
};
