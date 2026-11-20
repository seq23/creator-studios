import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { FPS, SIZES } from "./brand";
import { durationFrames, Piece, type PieceProps } from "./formats";

const metadata: CalculateMetadataFunction<PieceProps> = ({ props }) => ({
  durationInFrames: durationFrames(props),
  width: SIZES[props.size].width,
  height: SIZES[props.size].height,
  fps: FPS,
});

const sample: PieceProps = { brand: "pnp", format: "pov", size: "reel", bpm: 98, music: null, pics: [], hook: "POV:", lines: [""] };

export const Root: React.FC = () => <Composition id="Piece" component={Piece} defaultProps={sample} calculateMetadata={metadata} durationInFrames={300} fps={FPS} width={1080} height={1920} />;
