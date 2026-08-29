import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Chip, Table } from "@heroui/react";

interface Call {
	id: number;
	room: string;
	to_number: string | null;
	status: string;
	language: string | null;
	created_at: string;
	ended_at: string | null;
	event_count: number;
}
interface Event {
	id: number;
	kind: string;
	detail: string | null;
	created_at: string;
}
interface Lead {
	id: number;
	level: string;
	notes: string;
	created_at: string;
}
interface Callback {
	id: number;
	when_text: string;
	to_number: string;
	done: number;
}
interface Stats {
	total_calls: number;
	hot: number;
	warm: number;
	cold: number;
	pending_callbacks: number;
}

const KIND: Record<string, { label: string; tone: string; dot: string }> = {
	dial: {
		label: "Dialed",
		tone: "text-foreground/70",
		dot: "bg-foreground/60",
	},
	answered: { label: "Answered", tone: "text-success", dot: "bg-success" },
	heard: {
		label: "Customer said",
		tone: "text-foreground/80",
		dot: "bg-foreground/40",
	},
	language: {
		label: "Language detected",
		tone: "text-accent",
		dot: "bg-accent",
	},
	classify: { label: "Classified", tone: "text-warning", dot: "bg-warning" },
	whatsapp: { label: "WhatsApp sent", tone: "text-success", dot: "bg-success" },
	callback: {
		label: "Callback booked",
		tone: "text-foreground",
		dot: "bg-accent",
	},
	followup: {
		label: "Follow-up sent",
		tone: "text-success",
		dot: "bg-success",
	},
	ended: {
		label: "Call ended",
		tone: "text-foreground/70",
		dot: "bg-foreground/60",
	},
	failed: { label: "Failed", tone: "text-danger", dot: "bg-danger" },
};

async function getJSON<T>(url: string): Promise<T> {
	const r = await fetch(url);
	return (await r.json()) as T;
}

const timeAgo = (s: string) => {
	const ms = Date.now() - new Date(s.endsWith("Z") ? s : s + "Z").getTime();
	const m = Math.floor(ms / 60000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
};

export default function App() {
	const [stats, setStats] = useState<Stats | null>(null);
	const [calls, setCalls] = useState<Call[]>([]);
	const [leads, setLeads] = useState<Lead[]>([]);
	const [callbacks, setCallbacks] = useState<Callback[]>([]);
	const [events, setEvents] = useState<Event[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const manualSelected = useRef(false);
	const [calling, setCalling] = useState(false);
	const [number, setNumber] = useState<string>("");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<string>("");
	const [msg, setMsg] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const timer = useRef<number | null>(null);

	useEffect(() => {
		const saved = localStorage.getItem("dial-number");
		getJSON<{ target_number: string }>("/api/config")
			.then((c) => setNumber(saved || c.target_number))
			.catch(() => setNumber(saved || ""));
	}, []);

	function startEdit() {
		setDraft(number);
		setEditing(true);
	}
	function saveEdit() {
		const clean = draft.replace(/[^\d+]/g, "");
		if (clean) {
			setNumber(clean);
			localStorage.setItem("dial-number", clean);
		}
		setEditing(false);
	}

	const refresh = useCallback(async () => {
		try {
			const [s, c, l, cb] = await Promise.all([
				getJSON<Stats>("/api/stats"),
				getJSON<Call[]>("/api/calls"),
				getJSON<Lead[]>("/api/leads"),
				getJSON<Callback[]>("/api/callbacks"),
			]);
			setStats(s);
			setCalls(c);
			setLeads(l);
			setCallbacks(cb);
			if (selected)
				setEvents(await getJSON<Event[]>(`/api/calls/${selected}/events`));
			setErr(null);
		} catch {
			setErr("Dashboard can't reach the API. Is it running on :3000?");
		}
	}, [selected]);

	useEffect(() => {
		refresh();
		timer.current = window.setInterval(refresh, 5000);
		return () => {
			if (timer.current) window.clearInterval(timer.current);
		};
	}, [refresh]);

	// Auto-follow a genuinely live call (started recently) so the activity
	// stream updates, but only until the user picks a row manually.
	useEffect(() => {
		if (manualSelected.current) return;
		const live = calls.find(
			(c) =>
				(c.status === "active" || c.status === "started") &&
				Date.now() -
					new Date(
						c.created_at.endsWith("Z") ? c.created_at : c.created_at + "Z",
					).getTime() <
					15 * 60 * 1000,
		);
		if (live) setSelected(live.room);
	}, [calls]);

	async function startCall() {
		setCalling(true);
		setErr(null);
		setMsg(null);
		try {
			const r = await fetch("/api/call/start", {
				method: "POST",
				headers: {
					"X-API-Key": "elevatebox123",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ to: number }),
			});
			if (!r.ok) throw new Error("call failed to start");
			const { room } = await r.json();
			setMsg(room);
		} catch (e) {
			setErr(String(e));
		} finally {
			setCalling(false);
		}
	}

	const liveCall = stats?.total_calls ?? 0;
	const activeCall =
		calls.find((c) => c.status === "active" || c.status === "started") || null;

	return (
		<div className="min-h-[100dvh]">
			{/* header */}
			<header className="sticky top-0 z-20 border-b border-default/60 bg-background/80 backdrop-blur">
				<div className="mx-auto flex max-w-[1400px] items-center justify-between gap-6 px-5 py-4 lg:px-10">
					<div className="flex items-center gap-3">
						<span className="relative flex size-2">
							<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
							<span className="relative inline-flex size-2 rounded-full bg-accent" />
						</span>
						<div>
							<p className="text-sm font-semibold tracking-tight">WireTap AI</p>
							<p className="font-mono text-[11px] uppercase tracking-widest text-muted">
								Voice Sales Agent
							</p>
						</div>
					</div>
					<div className="flex items-center gap-6">
						{activeCall && activeCall.status === "active" && (
							<div className="flex items-center gap-2 rounded-full border border-success/40 bg-success/10 px-3 py-1.5">
								<span className="relative flex size-2">
									<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
									<span className="relative inline-flex size-2 rounded-full bg-success" />
								</span>
								<span className="font-mono text-xs font-medium text-success">
									IN CALL
								</span>
								<span className="font-mono text-[11px] text-muted">
									{activeCall.room}
								</span>
							</div>
						)}
						{activeCall && activeCall.status === "started" && (
							<div className="flex items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-3 py-1.5">
								<span className="relative flex size-2">
									<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-70" />
									<span className="relative inline-flex size-2 rounded-full bg-warning" />
								</span>
								<span className="font-mono text-xs font-medium text-warning">
									RINGING
								</span>
								<span className="font-mono text-[11px] text-muted">
									{activeCall.room}
								</span>
							</div>
						)}
						<div className="flex items-center gap-2">
							{/* dial number: edit to change, save to confirm */}
							<div className="flex h-10 items-center gap-1 rounded-md border border-default/60 bg-surface pl-3 pr-1">
								{editing ? (
									<>
										<input
											autoFocus
											type="tel"
											value={draft}
											onChange={(e) => setDraft(e.target.value)}
											onKeyDown={(e) => e.key === "Enter" && saveEdit()}
											placeholder="+91…"
											className="h-full w-40 bg-transparent font-mono text-sm text-foreground outline-none placeholder:text-muted"
										/>
										<button
											type="button"
											onClick={saveEdit}
											title="Save number"
											className="flex size-7 items-center justify-center rounded text-muted hover:bg-default/30 hover:text-success"
										>
											<CheckIcon />
										</button>
									</>
								) : (
									<>
										<span className="font-mono text-sm text-foreground">
											{number || <span className="text-muted">add number</span>}
										</span>
										<button
											type="button"
											onClick={startEdit}
											title="Edit number"
											className="flex size-7 items-center justify-center rounded text-muted hover:bg-default/30 hover:text-foreground"
										>
											<PencilIcon />
										</button>
									</>
								)}
							</div>
							<Button
								size="md"
								isDisabled={!number || calling}
								onPress={startCall}
								className="active:translate-y-[1px]"
							>
								{calling ? "Dialing…" : "Start a call"}
							</Button>
						</div>
					</div>
				</div>
			</header>

			{err && (
				<div className="mx-auto mt-4 max-w-[1400px] px-5 lg:px-10">
					<div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
						{err}
					</div>
				</div>
			)}
			{msg && (
				<div className="mx-auto mt-4 max-w-[1400px] px-5 lg:px-10">
					<div className="rounded-md border border-accent/40 bg-accent/10 px-4 py-3 font-mono text-sm">
						Call started — room {msg}
					</div>
				</div>
			)}

			{/* stats strip: numbers in mono, divided, no boxes */}
			<section className="mx-auto grid max-w-[1400px] grid-cols-2 gap-6 px-5 py-8 sm:grid-cols-5 lg:px-10">
				<Metric label="Total calls" value={liveCall} />
				<Metric
					label="Hot leads"
					value={stats?.hot ?? "—"}
					tone="text-danger"
				/>
				<Metric
					label="Warm leads"
					value={stats?.warm ?? "—"}
					tone="text-warning"
				/>
				<Metric
					label="Cold leads"
					value={stats?.cold ?? "—"}
					tone="text-muted"
				/>
				<Metric
					label="Pending callbacks"
					value={stats?.pending_callbacks ?? "—"}
					tone="text-success"
				/>
			</section>

			{/* main: asymmetric split */}
			<main className="mx-auto grid max-w-[1400px] grid-cols-1 gap-8 px-5 pb-16 lg:grid-cols-5 lg:px-10">
				{/* calls table (3/5) */}
				<section className="lg:col-span-3">
					<SectionHead
						title="Calls"
						sub="Every outbound call and the decisions made."
					/>
					<div className="rounded-lg">
						{calls.length === 0 ? (
							<EmptyState
								line="No calls yet."
								hint="No calls yet. Start a live call to see the agent work in real time."
							/>
						) : (
							<Table>
								<Table.ScrollContainer className="max-h-[360px]">
									<Table.Content
										aria-label="Calls"
										selectionMode="single"
										onSelectionChange={(keys) => {
											const k = Array.from(keys as Set<string>)[0];
											if (k) {
												manualSelected.current = true;
												setSelected(k);
											}
										}}
									>
										<Table.Header>
											<Table.Column isRowHeader>Room</Table.Column>
											<Table.Column>Status</Table.Column>
											<Table.Column>Lang</Table.Column>
											<Table.Column>When</Table.Column>
										</Table.Header>
										<Table.Body>
											{calls.map((c) => (
												<Table.Row
													key={c.room}
													id={c.room}
													className="font-mono"
												>
													<Table.Cell className="font-mono text-xs">
														{c.room}
													</Table.Cell>
													<Table.Cell>
														<Chip
															size="sm"
															color={
																c.status === "failed"
																	? "danger"
																	: c.status === "active"
																		? "success"
																		: "default"
															}
														>
															{c.status}
														</Chip>
													</Table.Cell>
													<Table.Cell className="font-mono text-xs uppercase">
														{c.language || "—"}
													</Table.Cell>
													<Table.Cell className="text-xs text-muted">
														{timeAgo(c.created_at)}
													</Table.Cell>
												</Table.Row>
											))}
										</Table.Body>
									</Table.Content>
								</Table.ScrollContainer>
							</Table>
						)}
					</div>
				</section>

				{/* call activity (2/5) */}
				<section className="lg:col-span-2">
					<SectionHead
						title="Call Activity"
						sub={
							selected
								? selected
								: "Select a call to inspect its events, in order."
						}
					/>
					<div className="relative rounded-lg border border-default/60 p-5">
						{!selected && (
							<EmptyState
								line="No call selected."
								hint="Click a row on the left to see the agent's decisions, in order."
							/>
						)}
						{selected && events.length === 0 && (
							<EmptyState
								line="No events yet."
								hint="This call hasn't recorded actions yet."
							/>
						)}
						<div className="max-h-[360px] overflow-y-auto pr-2">
							<ol className="relative space-y-0">
								{events.map((e, i) => {
									const k = KIND[e.kind] || {
										label: e.kind,
										tone: "text-foreground/70",
										dot: "bg-foreground/60",
									};
									const last = i === events.length - 1;
									const heard = e.kind === "heard";
									const lang = e.kind === "language";
									return (
										<li
											key={e.id}
											className="relative flex gap-4 pb-5 last:pb-0"
										>
											{/* line */}
											{!last && (
												<span className="absolute left-[5px] top-4 h-full w-px bg-default/50" />
											)}
											{/* dot */}
											<span
												className={`relative top-1 size-[11px] shrink-0 rounded-full border-2 border-background ${k.dot}`}
											/>
											<div className="min-w-0 flex-1">
												<p className="text-xs font-medium">{k.label}</p>
												{heard && e.detail && (
													<p className="mt-1 rounded-md border-l-2 border-default/60 bg-default/20 px-3 py-2 text-sm italic leading-snug text-foreground/90">
														“{e.detail}”
													</p>
												)}
												{!heard && e.detail && (
													<p
														className={`mt-1 text-sm leading-snug ${lang ? "font-mono uppercase text-accent" : "text-foreground/80"}`}
													>
														{e.detail}
													</p>
												)}
												<p className="mt-1 font-mono text-[10px] text-muted">
													{timeAgo(e.created_at)}
												</p>
											</div>
										</li>
									);
								})}
							</ol>
						</div>
					</div>
				</section>
			</main>

			{/* leads + callbacks: divide-y, not card boxes */}
			<section className="mx-auto grid max-w-[1400px] grid-cols-1 gap-8 px-5 pb-20 lg:grid-cols-2 lg:px-10">
				<div>
					<SectionHead
						title="Leads"
						sub="Hot, warm or cold — as read from indirect answers."
					/>
					{leads.length === 0 ? (
						<EmptyState
							line="No leads yet."
							hint="Classifications appear here once the agent reads a buyer."
						/>
					) : (
						<div className="divide-y divide-default/60 rounded-lg border border-default/60 px-5">
							{leads.map((l) => (
								<div key={l.id} className="flex items-start gap-4 py-4">
									<Chip
										size="sm"
										color={
											l.level === "HOT"
												? "danger"
												: l.level === "WARM"
													? "warning"
													: "default"
										}
									>
										{l.level}
									</Chip>
									<div>
										<p className="text-sm leading-snug">{l.notes}</p>
										<p className="mt-1 font-mono text-[10px] text-muted">
											{timeAgo(l.created_at)}
										</p>
									</div>
								</div>
							))}
						</div>
					)}
				</div>

				<div>
					<SectionHead
						title="Callbacks"
						sub="Spoken times the scheduler calls back."
					/>
					{callbacks.length === 0 ? (
						<EmptyState
							line="No callbacks."
							hint="If a caller says 'call me tomorrow morning', it becomes a scheduled callback here."
						/>
					) : (
						<div className="divide-y divide-default/60 rounded-lg border border-default/60 px-5">
							{callbacks.map((cb) => (
								<div key={cb.id} className="flex items-center gap-4 py-4">
									<Chip size="sm" color={cb.done ? "success" : "warning"}>
										{cb.done ? "done" : "pending"}
									</Chip>
									<span className="text-sm">{cb.when_text}</span>
									<span className="ml-auto font-mono text-xs text-muted">
										{cb.to_number}
									</span>
								</div>
							))}
						</div>
					)}
				</div>
			</section>

			<footer className="border-t border-default/50 py-5">
				<p className="mx-auto max-w-[1400px] px-5 text-xs text-muted lg:px-10">
					LiveKit · Sarvam AI · DeepSeek · Baileys — served by the same API that
					places the call.
				</p>
			</footer>
		</div>
	);
}

function Metric({
	label,
	value,
	tone = "text-foreground",
}: {
	label: string;
	value: number | string;
	tone?: string;
}) {
	return (
		<div className="border-l-2 border-default/60 pl-4">
			<p className="text-[11px] font-medium uppercase tracking-widest text-muted">
				{label}
			</p>
			<p
				className={`mt-1 font-mono text-4xl font-semibold tabular-nums tracking-tight ${tone}`}
			>
				{value}
			</p>
		</div>
	);
}

function SectionHead({ title, sub }: { title: string; sub: string }) {
	return (
		<div className="mb-4">
			<h2 className="text-lg font-semibold tracking-tight">{title}</h2>
			<p className="mt-0.5 text-sm text-muted">{sub}</p>
		</div>
	);
}

function EmptyState({ line, hint }: { line: string; hint: string }) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
			<span className="relative flex size-2.5">
				<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-40" />
				<span className="relative inline-flex size-2.5 rounded-full bg-accent/70" />
			</span>
			<p className="text-sm font-medium">{line}</p>
			<p className="max-w-[38ch] text-xs text-muted">{hint}</p>
		</div>
	);
}

function PencilIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
		</svg>
	);
}

function CheckIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M20 6 9 17l-5-5" />
		</svg>
	);
}
