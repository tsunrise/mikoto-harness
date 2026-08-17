export interface RequestUserInputOption {
	label: string;
	description: string;
}

export interface RequestUserInputQuestion {
	id: string;
	header: string;
	question: string;
	options: RequestUserInputOption[];
}

export interface RequestUserInputAnswer {
	answers: string[];
}

export interface RequestUserInputResponse {
	answers: Record<string, RequestUserInputAnswer>;
}

export interface RequestUserInputDetails {
	status: "answered";
	questions: RequestUserInputQuestion[];
	response: RequestUserInputResponse;
}

export interface DndState {
	enabled: boolean;
	enabledSinceLastTurnEnd: boolean;
	availabilityNoticePending: boolean;
}

export type QuestionnaireFocus = "options" | "notes" | "unanswered-confirmation";

export interface QuestionnaireAnswerState {
	highlightedIndex: number | null;
	committed: boolean;
	note: string;
	notesVisible: boolean;
}

export type QuestionnaireAction =
	| { type: "render" }
	| { type: "complete"; response: RequestUserInputResponse }
	| { type: "interrupt" };

export type QuestionnaireOutcome =
	| { status: "answered"; response: RequestUserInputResponse }
	| { status: "interrupted" };
