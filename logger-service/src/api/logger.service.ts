import { LargePayloadContainer, MessageError, MessageResponse, Log, DatabaseServer, MAP_ATTRIBUTES_AGGREGATION_FILTERS } from '@guardian/common';
import { MessageAPI } from '@guardian/interfaces';
import { Controller, Module } from '@nestjs/common';
import { ClientsModule, Ctx, MessagePattern, NatsContext, Payload, Transport } from '@nestjs/microservices';
import process from 'process';
import { FilterObject } from '@mikro-orm/core';

@Controller()
export class LoggerService {
    /**
     * Add log message
     *
     * @param data
     * @param context
     */
    @MessagePattern(MessageAPI.WRITE_LOG, Transport.NATS)
    async writeLog(@Payload() message: any, @Ctx() context: NatsContext) {
        const logRepository = new DatabaseServer();
        try {
            if (!message) {
                throw new Error('Log message is empty');
            }

            await logRepository.save(Log, message);

            // if (message.type === LogType.ERROR) {
            //     channel.publish(ExternalMessageEvents.ERROR_LOG, message);
            // }
            return new MessageResponse(true);
        }
        catch (error) {
            return new MessageError(error);
        }
    }

    @MessagePattern(MessageAPI.GET_LOGS, Transport.NATS)
    async getLogs(@Payload() msg: any, @Ctx() context: NatsContext) {
        try {
            const logRepository = new DatabaseServer();

            const filters = msg && msg.filters || {};
            if (filters.datetime && filters.datetime.$gte && filters.datetime.$lt) {
                filters.datetime.$gte = new Date(filters.datetime.$gte);
                filters.datetime.$lt = new Date(filters.datetime.$lt);
            }
            const pageParameters = msg && msg.pageParameters || {};
            // if (!pageParameters.limit) {
            //     pageParameters.limit = 2000;
            // }
            const logs = await logRepository.find(Log, filters, {
                    orderBy: {
                        datetime: msg.sortDirection && msg.sortDirection.toUpperCase() || 'DESC'
                    },
                    ...pageParameters
            });
            const totalCount = await logRepository.count(Log, filters as any);
            const directLink = new LargePayloadContainer().addObject(Buffer.from(JSON.stringify(logs)));
            return new MessageResponse({
                directLink,
                totalCount
            });
        }
        catch (error) {
            return new MessageError(error);
        }
    }

    @MessagePattern(MessageAPI.GET_ATTRIBUTES, Transport.NATS)
    async getAttributes(@Payload() msg: any, @Ctx() context: NatsContext) {
        const logRepository = new DatabaseServer();

        try {
            const nameFilter = `.*${msg.name || ''}.*`;
            const existingAttributes = msg.existingAttributes || [];

            const aggregateAttrResult =
                await logRepository.aggregate(Log, logRepository.getAttributesAggregationFilters(MAP_ATTRIBUTES_AGGREGATION_FILTERS.RESULT, nameFilter, existingAttributes) as FilterObject<any>[]);

            return new MessageResponse(aggregateAttrResult[0].uniqueValues?.sort() || []);
        }
        catch (error) {
            return new MessageError<string>(error.toString());
        }
    }
}

// class LogClientSerializer implements Serializer {
//     serialize(value: any, options?: Record<string, any>): any {
//         console.log('s', value, options);
//
//         value.data = JSON.stringify(value.data)
//
//         return value;
//     }
// }
//
// class LogClientDeserializer implements Deserializer {
//     deserialize(value: any, options?: Record<string, any>): any {
//         console.log('d', value, options);
//         return value;
//     }
// }

/**
 * Logger module
 */
@Module({
    imports: [
        ClientsModule.register([{
            name: 'LOGGER',
            transport: Transport.NATS,
            options: {
                servers: [
                    `nats://${process.env.MQ_ADDRESS}:4222`
                ],
                queue: 'logger-service',
                // serializer: new LogClientSerializer(),
                // deserializer: new LogClientDeserializer(),
            }
        }]),
    ],
    controllers: [
        LoggerService
    ]
})
export class LoggerModule {}
