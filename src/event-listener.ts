/**
 * This is a class-based refactor of the original `mitt` event emitter.
 * Based on mitt (MIT License) by Jason Miller - https://github.com/developit/mitt
 *
 * This version was modified for internal usage as a class-based emitter.
 *
 * The MIT License (MIT)
 * Copyright (c) Jason Miller
 */

export type EventType = string | symbol;

export type Handler<T = unknown> = (event: T) => void;
export type WildcardHandler<T = Record<string, unknown>> = (
	type: keyof T,
	event: T[keyof T],
) => void;

export type EventHandlerList<T = unknown> = Array<Handler<T>>;
export type WildCardEventHandlerList<T = Record<string, unknown>> = Array<
	WildcardHandler<T>
>;

export type EventHandlerMap<Events extends Record<EventType, unknown>> = Map<
	keyof Events | "*",
	EventHandlerList<Events[keyof Events]> | WildCardEventHandlerList<Events>
>;

export class Mitt<Events extends Record<EventType, unknown> = any> {
	private all: EventHandlerMap<Events>;

	constructor(all?: EventHandlerMap<Events>) {
		this.all = all || new Map();
	}

	/**
	 * Register an event handler for the given type.
	 */
	on<Key extends keyof Events>(type: Key, handler: Handler<Events[Key]>): void;
	on(type: "*", handler: WildcardHandler<Events>): void;
	on<Key extends keyof Events>(
		type: Key | "*",
		handler: Handler<Events[Key]> | WildcardHandler<Events>,
	): void {
		const handlers = this.all.get(type);
		if (handlers) {
			handlers.push(handler as any);
		} else {
			this.all.set(type, [handler] as any);
		}
	}

	/**
	 * Remove an event handler for the given type.
	 */
	off<Key extends keyof Events>(
		type: Key,
		handler?: Handler<Events[Key]>,
	): void;
	off(type: "*", handler: WildcardHandler<Events>): void;
	off<Key extends keyof Events>(
		type: Key | "*",
		handler?: Handler<Events[Key]> | WildcardHandler<Events>,
	): void {
		const handlers = this.all.get(type);
		if (!handlers) return;

		if (handler) {
			const index = handlers.indexOf(handler as any);
			if (index !== -1) {
				handlers.splice(index, 1);
			}
		} else {
			this.all.set(type, []);
		}
	}

	/**
	 * Invoke all handlers for the given type.
	 */
	protected emit<Key extends keyof Events>(
		type: Key,
		event: Events[Key],
	): void {
		const handlers = this.all.get(type);
		if (handlers) {
			(handlers as EventHandlerList<Events[Key]>)
				.slice()
				.forEach((h) => h(event));
		}

		const wildcards = this.all.get("*");
		if (wildcards) {
			(wildcards as WildCardEventHandlerList<Events>)
				.slice()
				.forEach((h) => h(type, event));
		}
	}
}
