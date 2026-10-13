import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

const challengeSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    kind: { type: String, enum: ["html", "image"], required: true },
    html: { type: String },
    targetFile: { type: String, required: true },
    starterCode: { type: String, default: "" },
    builtIn: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const playerSchema = new Schema(
  {
    slot: { type: String, enum: ["A", "B"], required: true },
    name: { type: String, required: true },
    handle: { type: String, default: "" },
    avatarUrl: { type: String },
    tokenHash: { type: String, required: true },
    officialScore: { type: Number, default: null },
    /** Set at the end when the final code was still the untouched starter */
    didNotStart: { type: Boolean, default: false },
  },
  { _id: false },
);

const matchSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    status: { type: String, enum: ["lobby", "live", "finished"], default: "lobby" },
    challenge: { type: Schema.Types.ObjectId, ref: "Challenge", required: true },
    durationSec: { type: Number, required: true },
    players: { type: [playerSchema], required: true },
    adminKeyHash: { type: String, required: true },
    startedAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    winner: { type: String, enum: ["A", "B", "tie", null], default: null },
  },
  { timestamps: true },
);

const submissionSchema = new Schema(
  {
    match: { type: Schema.Types.ObjectId, ref: "Match", required: true, index: true },
    slot: { type: String, enum: ["A", "B"], required: true },
    code: { type: String, required: true },
    score: { type: Number, required: true },
    regions: [{ x: Number, y: Number, w: Number, h: Number, density: Number, _id: false }],
    diffFile: { type: String, required: true },
    renderFile: { type: String, required: true },
    final: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type Challenge = InferSchemaType<typeof challengeSchema>;
export type Match = InferSchemaType<typeof matchSchema>;
export type MatchDoc = HydratedDocument<Match>;
export type ChallengeDoc = HydratedDocument<Challenge>;

export const ChallengeModel = mongoose.model("Challenge", challengeSchema);
export const MatchModel = mongoose.model("Match", matchSchema);
export const SubmissionModel = mongoose.model("Submission", submissionSchema);
