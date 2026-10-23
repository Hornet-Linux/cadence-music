import type { Plugin } from "@/plugins/types";
import { QuizIcon } from "../_social/ui";
import { QUIZ_ITEM_ID, QuizPage } from "./QuizPage";

/** A guess-the-song quiz built from your own library: short snippets, four choices, a score. */
const quiz: Plugin = {
  manifest: {
    id: "cadence.quiz",
    name: "Song quiz",
    version: "1.0.0",
    description: "Guess the song from a short snippet. Choose a difficulty and see how well you know your library.",
    author: "Cadence",
    capabilities: ["ui.sidebar"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    ctx.registerSidebarItem({ id: QUIZ_ITEM_ID, label: "Quiz", icon: <QuizIcon />, render: () => <QuizPage /> });
  },
};

export default quiz;