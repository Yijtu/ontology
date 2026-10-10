import { PROJECT_EVOLUTION_TOPIC, isRecord, isUuid } from '@ontology/contracts'
import type { OutboxMessageRecord, ToolContext } from '@ontology/contracts'
import type { OutboxConsumer, ProjectEvolutionService } from '@ontology/application'
/** Registration leaf for the normal topic router. Durable CAS owns bounded rebuild attempts. */
export class ProjectEvolutionOutboxConsumer implements OutboxConsumer {
    readonly topics = [PROJECT_EVOLUTION_TOPIC]
    constructor(private readonly service: Pick<ProjectEvolutionService,'rebuild'>) {
    }
    canHandle(topic: string): boolean {
        return topic === PROJECT_EVOLUTION_TOPIC
    }
    async consume(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
        if (!this.canHandle(message.topic) || !isRecord(message.payload) || !isUuid(message.payload.projectId) || !isUuid(message.payload.evolutionId))
            throw new Error('invalid project evolution outbox message')
        await this.service.rebuild(message.payload.projectId, message.payload.evolutionId, ctx)
    }
}
