import {
    BinaryMessageResponse,
    DatabaseServer,
    findAllEntities,
    GenerateBlocks,
    IAuthUser,
    IMessageResponse,
    JsonToXlsx,
    MessageAction,
    MessageError,
    MessageResponse,
    MessageServer,
    MessageType,
    NatsService,
    PinoLogger,
    Policy,
    PolicyImportExport,
    PolicyMessage,
    RecordImportExport,
    RunFunctionAsync,
    Schema as SchemaCollection,
    Singleton,
    TopicConfig,
    Users,
    VcHelper,
    XlsxToJson
} from '@guardian/common';
import { DocumentCategoryType, DocumentType, EntityOwner, ExternalMessageEvents, GenerateUUIDv4, IOwner, PolicyEngineEvents, PolicyEvents, PolicyHelper, PolicyTestStatus, PolicyType, Schema, SchemaField, TopicType } from '@guardian/interfaces';
import { AccountId, PrivateKey } from '@hashgraph/sdk';
import { NatsConnection } from 'nats';
import { HashComparator } from '../analytics/index.js';
import { getSchemaCategory, importSubTools, previewToolByMessage, SchemaImportExportHelper } from '../api/helpers/index.js';
import { compareResults, getDetails } from '../api/record.service.js';
import { Inject } from '../helpers/decorators/inject.js';
import { GuardiansService } from '../helpers/guardians.js';
import { emptyNotifier, initNotifier } from '../helpers/notifier.js';
import { BlockAboutString } from './block-about.js';
import { PolicyDataMigrator } from './helpers/policy-data-migrator.js';
import { PolicyDataLoader, VcDocumentLoader, VpDocumentLoader } from './helpers/policy-data/loaders/index.js';
import { PolicyDataImportExport } from './helpers/policy-data/policy-data-import-export.js';
import { PolicyImportExportHelper } from './helpers/policy-import-export-helper.js';
import { PolicyComponentsUtils } from './policy-components-utils.js';
import { PolicyEngine } from './policy-engine.js';
import { IPolicyUser } from './policy-user.js';

/**
 * PolicyEngineChannel
 */
@Singleton
export class PolicyEngineChannel extends NatsService {
    /**
     * Message queue name
     */
    public messageQueueName = 'policy-engine-queue';

    /**
     * Reply subject
     * @private
     */
    public replySubject = 'policy-engine-reply-' + GenerateUUIDv4();

    /**
     * Register listener
     * @param event
     * @param cb
     */
    registerListener(event: string, cb: Function): void {
        this.getMessages(event, cb);
    }
}

/**
 * Policy engine service
 */

export class PolicyEngineService {
    /**
     * Message broker service
     * @private
     */
    private readonly channel: PolicyEngineChannel;
    /**
     * Policy Engine
     * @private
     */
    private readonly policyEngine: PolicyEngine;
    /**
     * Users helper
     * @private
     */
    @Inject()
    declare private readonly users: Users;

    constructor(cn: NatsConnection, logger: PinoLogger) {
        this.channel = new PolicyEngineChannel();
        this.channel.setConnection(cn)
        this.policyEngine = new PolicyEngine(logger)
    }

    /**
     * Callback fires when block state changed
     * @param uuid {string} - id of block
     * @param user {IPolicyUser} - short user object
     */
    private async stateChangeCb(blocks: string[], user: IPolicyUser) {
        if (!user || !user.did) {
            return;
        }

        await this.channel.publish('update-block', {
            blocks,
            user
        });
    }

    /**
     * Block error callback
     * @param blockType
     * @param message
     * @param user
     * @private
     */
    private async blockErrorCb(blockType: string, message: any, user: IAuthUser) {
        if (!user || !user.did) {
            return;
        }

        await this.channel.publish('block-error', {
            blockType,
            message,
            user
        });
    }

    /**
     * Update user info
     * @param user
     * @param policy
     * @private
     */
    private async updateUserInfo(user: IPolicyUser, policy: Policy) {
        if (!user || !user.did) {
            return;
        }

        const userGroups = await PolicyComponentsUtils.GetGroups(policy.id.toString(), user);

        let userGroup = userGroups.find(g => g.active !== false);
        if (!userGroup) {
            userGroup = userGroups[0];
        }
        const userRole = userGroup ? userGroup.role : 'No role';

        await this.channel.publish('update-user-info', {
            policyId: policy.id.toString(),
            user: {
                did: user.virtual ? policy.owner : user.did,
                role: user.role
            },
            userRole,
            userGroup,
            userGroups
        });
    }

    private async createHashByFile(file: any, logger: PinoLogger): Promise<string> {
        try {
            const compareModel = await HashComparator.createModelByFile(file);
            const hash = HashComparator.createHash(compareModel);
            return hash
        } catch (error) {
            await logger.error(error, ['GUARDIAN_SERVICE, HASH']);
            return null;
        }
    }

    /**
     * Init
     */
    public async init(): Promise<void> {
        await this.channel.init();
    }

    /**
     * Register endpoints for policy engine
     * @private
     */
    public registerListeners(logger: PinoLogger): void {
        PolicyComponentsUtils.BlockUpdateFn = async (...args: any[]) => {
            await this.stateChangeCb.apply(this, args);
        };

        PolicyComponentsUtils.BlockErrorFn = async (...args: any[]) => {
            await this.blockErrorCb.apply(this, args);
        };

        PolicyComponentsUtils.UpdateUserInfoFn = async (...args: any[]) => {
            await this.updateUserInfo.apply(this, args);
        }

        PolicyComponentsUtils.ExternalEventFn = async (...args: any[]) => {
            try {
                this.channel.sendMessage(ExternalMessageEvents.BLOCK_EVENTS, args);
            } catch (error) {
                console.error(error);
            }
        };

        //#region Block endpoints
        this.channel.getMessages(PolicyEvents.BLOCK_UPDATE_BROADCAST,
            (msg: { type: string, data: any[] }) => {
                const { type, data } = msg;
                switch (type) {
                    case 'update': {
                        const [blocks, user] = data;
                        PolicyComponentsUtils.BlockUpdateFn(blocks, user);
                        break;
                    }
                    case 'error': {
                        const [blockType, message, user] = data;
                        PolicyComponentsUtils.BlockErrorFn(blockType, message, user);
                        break;
                    }
                    case 'update-user': {
                        const [user, policy] = data;
                        PolicyComponentsUtils.UpdateUserInfoFn(user, policy);
                        break;
                    }
                    case 'external': {
                        const [event] = data;
                        PolicyComponentsUtils.ExternalEventFn(event);
                        break;
                    }
                    default:
                        throw new Error('Unknown type');
                }
            })

        this.channel.getMessages(PolicyEvents.RECORD_UPDATE_BROADCAST,
            async (msg: {
                id: string,
                type: string,
                policyId: string,
                status: string,
                index: number,
                error: string,
                count: number,
            }) => {
                const policy = await DatabaseServer.getPolicyById(msg.policyId);
                if (policy) {
                    const evert = { ...msg, user: { did: policy.owner } };
                    this.channel.publish('update-record', evert);
                }
            })

        this.channel.getMessages(PolicyEvents.TEST_UPDATE_BROADCAST,
            async (msg: {
                id: string,
                type: string,
                policyId: string,
                status: string,
                index: number,
                error: string,
                count: number,
                result: any
            }) => {
                if (!msg.id) {
                    return;
                }
                const test = await DatabaseServer.getPolicyTestByRecord(msg.id);
                if (test) {
                    const { status, index, count, error, result } = msg;
                    switch (status) {
                        case 'Running': {
                            test.status = PolicyTestStatus.Running;
                            test.progress = Math.floor(index / count * 100);
                            test.result = null;
                            test.error = null;
                            break;
                        }
                        case 'Stopped': {
                            test.result = await getDetails(result);
                            if (test.result?.total === 100) {
                                test.status = PolicyTestStatus.Success;
                            } else {
                                test.status = PolicyTestStatus.Failure;
                            }
                            test.progress = null;
                            test.error = null;
                            test.resultId = null;
                            break;
                        }
                        case 'Error': {
                            test.status = PolicyTestStatus.Failure;
                            test.result = null;
                            test.progress = null;
                            test.error = error;
                            test.resultId = null;
                            break;
                        }
                        case 'Finished': {
                            if (test.status === PolicyTestStatus.Running) {
                                test.status = PolicyTestStatus.Stopped;
                                test.result = null;
                                test.progress = null;
                                test.error = null;
                                test.resultId = null;
                                break;
                            } else {
                                return;
                            }
                        }
                        default: {
                            return;
                        }
                    }
                    await DatabaseServer.updatePolicyTest(test);
                    const evert = {
                        id: test.id,
                        policyId: test.policyId,
                        date: test.date,
                        progress: test.progress,
                        status: test.status,
                        user: { did: test.owner }
                    };
                    this.channel.publish('update-test', evert);
                }
            })

        this.channel.getMessages<any, any>('mrv-data',
            async (msg: any) => {
                // await PolicyComponentsUtils.ReceiveExternalData(msg);
                const policy = await DatabaseServer.getPolicyByTag(msg?.policyTag);
                if (policy) {
                    const policyId = policy.id.toString();
                    await new GuardiansService()
                        .sendPolicyMessage(PolicyEvents.MRV_DATA, policyId, {
                            policyId,
                            data: msg
                        });
                }
                return new MessageResponse({})
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_BLOCKS,
            async (msg: { policyId: string, user: IAuthUser }): Promise<IMessageResponse<any>> => {
                try {
                    const { user, policyId } = msg;

                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, new EntityOwner(user), 'execute');

                    const error = new PolicyEngine(logger).getPolicyError(policyId);

                    if (error) {
                        throw new Error(error);
                    }
                    const blockData = await new GuardiansService()
                        .sendBlockMessage(PolicyEvents.GET_ROOT_BLOCK_DATA, policyId, {
                            user,
                            policyId
                        }) as any;
                    return new MessageResponse(blockData);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error, error.code);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_BLOCK_DATA,
            async (msg: { user: IAuthUser, blockId: string, policyId: string, params: any }): Promise<IMessageResponse<any>> => {
                try {
                    const { user, blockId, policyId, params } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, new EntityOwner(user), 'execute');
                    const blockData = await new GuardiansService()
                        .sendBlockMessage(PolicyEvents.GET_BLOCK_DATA, policyId, {
                            user,
                            blockId,
                            policyId,
                            params
                        }) as any
                    return new MessageResponse(blockData);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error, error.code);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_BLOCK_DATA_BY_TAG,
            async (msg: { user: IAuthUser, tag: string, policyId: string, params: any }): Promise<IMessageResponse<any>> => {
                try {
                    const { user, tag, policyId, params } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, new EntityOwner(user), 'execute');
                    const blockData = await new GuardiansService()
                        .sendBlockMessage(PolicyEvents.GET_BLOCK_DATA_BY_TAG, policyId, {
                            user,
                            tag,
                            policyId,
                            params
                        }) as any
                    return new MessageResponse(blockData);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error, error.code);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.SET_BLOCK_DATA,
            async (msg: { user: IAuthUser, blockId: string, policyId: string, data: any }): Promise<IMessageResponse<any>> => {
                try {
                    const { user, blockId, policyId, data } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, new EntityOwner(user), 'execute');
                    const blockData = await new GuardiansService()
                        .sendBlockMessage(PolicyEvents.SET_BLOCK_DATA, policyId, {
                            user,
                            blockId,
                            policyId,
                            data
                        }) as any;
                    return new MessageResponse(blockData);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error, error.code);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.SET_BLOCK_DATA_BY_TAG,
            async (msg: { user: IAuthUser, tag: string, policyId: string, data: any }): Promise<IMessageResponse<any>> => {
                try {
                    const { user, tag, policyId, data } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, new EntityOwner(user), 'execute');
                    const blockData = await new GuardiansService()
                        .sendBlockMessage(PolicyEvents.SET_BLOCK_DATA_BY_TAG, policyId, {
                            user,
                            tag,
                            policyId,
                            data
                        }) as any
                    return new MessageResponse(blockData);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error, error.code);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.BLOCK_BY_TAG,
            async (msg: { user: IAuthUser, tag: string, policyId: string }): Promise<IMessageResponse<any>> => {
                try {
                    const { user, tag, policyId } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, new EntityOwner(user), 'execute');
                    const blockData = await new GuardiansService()
                        .sendPolicyMessage(PolicyEvents.BLOCK_BY_TAG, policyId, {
                            tag,
                            policyId,
                        }) as any
                    return new MessageResponse(blockData);
                } catch (error) {
                    return new MessageError('The policy does not exist, or is not published, or tag was not registered in policy', 404);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_BLOCK_PARENTS,
            async (msg: { user: IAuthUser, blockId: string, policyId: string }): Promise<IMessageResponse<any>> => {
                try {
                    const { user, blockId, policyId } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, new EntityOwner(user), 'execute');
                    const blockData = await new GuardiansService()
                        .sendPolicyMessage(PolicyEvents.GET_BLOCK_PARENTS, policyId, { blockId });
                    return new MessageResponse(blockData);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error, error.code);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_POLICY_NAVIGATION,
            async (msg: { user: IAuthUser, policyId: string }): Promise<IMessageResponse<any>> => {
                try {
                    const { user, policyId } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, new EntityOwner(user), 'execute');
                    const navigationData = await new GuardiansService()
                        .sendPolicyMessage(PolicyEvents.GET_POLICY_NAVIGATION, policyId, {
                            user
                        }) as any;
                    return new MessageResponse(navigationData);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error, error.code);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_POLICY_GROUPS,
            async (msg: { user: IAuthUser, policyId: string }): Promise<IMessageResponse<any>> => {
                try {
                    const { user, policyId } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, new EntityOwner(user), 'execute');
                    const blockData = await new GuardiansService()
                        .sendPolicyMessage(PolicyEvents.GET_POLICY_GROUPS, policyId, {
                            user,
                            policyId
                        }) as any;
                    return new MessageResponse(blockData);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error, error.code);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.SELECT_POLICY_GROUP,
            async (msg: { user: IAuthUser, policyId: string, uuid: string }): Promise<IMessageResponse<any>> => {
                try {
                    const { user, policyId, uuid } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, new EntityOwner(user), 'execute');
                    const blockData = await new GuardiansService()
                        .sendPolicyMessage(PolicyEvents.SELECT_POLICY_GROUP, policyId, {
                            user,
                            policyId,
                            uuid
                        }) as any;
                    return new MessageResponse(blockData);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error, error.code);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.RECEIVE_EXTERNAL_DATA,
            async (msg: any) => {
                try {
                    const policy = await DatabaseServer.getPolicyByTag(msg?.policyTag);
                    if (policy) {
                        const policyId = policy.id.toString();
                        new GuardiansService().sendPolicyMessage(PolicyEvents.MRV_DATA, policyId, {
                            policyId,
                            data: msg
                        });
                    }
                    return new MessageResponse(true);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error, error.code);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_TAG_BLOCK_MAP,
            async (msg: { policyId: string, owner: IOwner }) => {
                try {
                    const { policyId, owner } = msg;
                    const userPolicy = await DatabaseServer.getPolicyCache({
                        id: policyId,
                        userId: owner.creator
                    });
                    if (userPolicy) {
                        return new MessageResponse(userPolicy.blocks);
                    }

                    const policy = await DatabaseServer.getPolicy({
                        id: policyId,
                        status: {
                            $in: [
                                PolicyType.DRY_RUN,
                                PolicyType.PUBLISH,
                                PolicyType.DISCONTINUED,
                            ],
                        },
                    });
                    await this.policyEngine.accessPolicy(policy, owner, 'read');

                    const blocks =
                        await new GuardiansService().sendPolicyMessage(
                            PolicyEvents.GET_TAG_BLOCK_MAP,
                            policyId,
                            null
                        );
                    return new MessageResponse(blocks);
                } catch (error) {
                    return new MessageError(error, error.code);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.BLOCK_ABOUT, async () => {
            try {
                return new MessageResponse(BlockAboutString);
            } catch (error) {
                return new MessageError(error);
            }
        });
        //#endregion

        //#region Policy endpoints
        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_POLICY,
            async (msg: {
                options: { filters: any, userDid: string },
                owner: IOwner
            }) => {
                const { options, owner } = msg;
                const { filters, userDid } = options;
                const policy = await DatabaseServer.getPolicy(filters);
                await this.policyEngine.accessPolicy(policy, owner, 'read');
                const result: any = policy;
                if (policy) {
                    await PolicyComponentsUtils.GetPolicyInfo(policy, userDid);
                }
                return new MessageResponse(result);
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_POLICIES,
            async (msg: { options: any, owner: IOwner }) => {
                try {
                    const { options, owner } = msg;
                    const { filters, pageIndex, pageSize } = options;
                    const _filters: any = { ...filters };
                    const otherOptions: any = {
                        fields: [
                            'id',
                            'uuid',
                            'name',
                            'version',
                            'previousVersion',
                            'description',
                            'status',
                            'creator',
                            'owner',
                            'topicId',
                            'policyTag',
                            'messageId',
                            'codeVersion',
                            'createDate',
                            'instanceTopicId',
                            'tools',
                            'policyGroups',
                            'policyRoles',
                            'discontinuedDate',
                        ]
                    };
                    const _pageSize = parseInt(pageSize, 10);
                    const _pageIndex = parseInt(pageIndex, 10);
                    if (Number.isInteger(_pageSize) && Number.isInteger(_pageIndex)) {
                        otherOptions.orderBy = { createDate: 'DESC' };
                        otherOptions.limit = _pageSize;
                        otherOptions.offset = _pageIndex * _pageSize;
                    } else {
                        otherOptions.orderBy = { createDate: 'DESC' };
                        otherOptions.limit = 100;
                    }
                    await this.policyEngine.addAccessFilters(_filters, owner);
                    const [policies, count] = await DatabaseServer.getPoliciesAndCount(_filters, otherOptions);
                    for (const policy of policies) {
                        await PolicyComponentsUtils.GetPolicyInfo(policy, owner.creator);
                    }
                    return new MessageResponse({ policies, count });
                } catch (error) {
                    return new MessageError(error);
                }
            });

        /**
         * Get policies V2 05.06.2024
         */
        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_POLICIES_V2,
            async (msg: { options: any, owner: IOwner }) => {
                try {
                    const { options, owner } = msg;
                    const { fields, filters, pageIndex, pageSize } = options;
                    const _filters: any = { ...filters };

                    const otherOptions: any = { fields };

                    const _pageSize = parseInt(pageSize, 10);
                    const _pageIndex = parseInt(pageIndex, 10);
                    if (Number.isInteger(_pageSize) && Number.isInteger(_pageIndex)) {
                        otherOptions.orderBy = { createDate: 'DESC' };
                        otherOptions.limit = _pageSize;
                        otherOptions.offset = _pageIndex * _pageSize;
                    } else {
                        otherOptions.orderBy = { createDate: 'DESC' };
                        otherOptions.limit = 100;
                    }
                    await this.policyEngine.addAccessFilters(_filters, owner);

                    const [policies, count] = await DatabaseServer.getPoliciesAndCount(_filters, otherOptions);
                    for (const policy of policies) {
                        await PolicyComponentsUtils.GetPolicyInfo(policy, owner.creator);
                    }
                    return new MessageResponse({ policies, count });
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_PUBLISH_POLICIES,
            async (): Promise<IMessageResponse<Policy[]>> => {
                try {
                    const publishPolicies = await DatabaseServer.getPublishPolicies();
                    return new MessageResponse(publishPolicies);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_FIELDS_DESCRIPTIONS,
            async (msg: { policiesData: any[] }): Promise<IMessageResponse<any[]>> => {
                try {
                    const { policiesData } = msg;
                    const policySchemas = [];
                    for (const policy of policiesData) {
                        const policyId = policy.policyId;
                        const topicId = policy.topicId;
                        const dbSchemas = await DatabaseServer.getSchemas({ topicId });
                        const schemas = dbSchemas.map((schema: SchemaCollection) => new Schema(schema));
                        const nonSystemSchemas = schemas.filter(schema => !schema.system);
                        const policyDescriptions: string[] = [];
                        for (const schema of nonSystemSchemas) {
                            const fields = schema?.fields;
                            const descriptions = fields.map((field: SchemaField) => field?.description);
                            policyDescriptions.push(...descriptions);
                        }
                        policySchemas.push({
                            policyId,
                            descriptions: Array.from(new Set(policyDescriptions))
                        });
                    }
                    return new MessageResponse(policySchemas);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_POLICIES_BY_CATEGORY,
            async (msg: { categoryIds: string[], text: string }): Promise<IMessageResponse<Policy[]>> => {
                try {
                    const { categoryIds, text } = msg;
                    const resultPolicies = await DatabaseServer.getFilteredPolicies(categoryIds, text);
                    return new MessageResponse(resultPolicies);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_MULTI_POLICY,
            async (msg: { owner: IOwner, policyId: string }) => {
                try {
                    const { owner, policyId } = msg;

                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');

                    const item = await DatabaseServer.getMultiPolicy(policy.instanceTopicId, owner.creator);
                    if (item) {
                        return new MessageResponse(item);
                    } else {
                        return new MessageResponse({
                            uuid: null,
                            instanceTopicId: policy.instanceTopicId,
                            mainPolicyTopicId: policy.instanceTopicId,
                            synchronizationTopicId: policy.synchronizationTopicId,
                            owner: owner.creator,
                            type: null
                        });
                    }
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.SET_MULTI_POLICY,
            async (msg: { owner: IOwner, policyId: string, data: any }) => {
                try {
                    const { owner, policyId, data } = msg;

                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');

                    const item = await DatabaseServer.getMultiPolicy(policy.instanceTopicId, owner.creator);
                    const userAccount = await this.users.getHederaAccount(owner.creator);
                    if (item) {
                        return new MessageError(new Error('Policy is already bound'));
                    } else {
                        const root = await this.users.getHederaAccount(policy.creator);
                        const result = await this.policyEngine.createMultiPolicy(policy, userAccount, root, data);
                        return new MessageResponse(result);
                    }
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_TOKENS_MAP,
            async (msg: { owner: IOwner, status: string }) => {
                try {
                    const { owner, status } = msg;
                    const filters: any = {};
                    if (status) {
                        filters.status = status;
                    }
                    await this.policyEngine.addAccessFilters(filters, owner);
                    const policies = await DatabaseServer.getPolicies(filters);
                    const map: any = [];
                    for (const policyObject of policies) {
                        const tokenIds = findAllEntities(policyObject.config, ['tokenId']);
                        map.push({
                            tokenIds,
                            name: policyObject.name,
                            version: policyObject.version,
                            id: policyObject.id,
                            status: policyObject.status
                        });
                    }
                    return new MessageResponse(map);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.ACCESS_POLICY,
            async (msg: { policyId: string, owner: IOwner, action: string }) => {
                try {
                    const { policyId, owner, action } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    const code = await this.policyEngine.accessPolicyCode(policy, owner);
                    if (code === 1) {
                        return new MessageError('Policy does not exist.', 404);
                    }
                    if (code === 2) {
                        return new MessageError(`Insufficient permissions to ${action} the policy.`, 403);
                    }
                    return new MessageResponse(policy);
                } catch (error: any) {
                    return new MessageError(error, 500);
                }
            });
        //#endregion

        //#region Actions endpoints
        this.channel.getMessages<any, any>(PolicyEngineEvents.CREATE_POLICIES,
            async (msg: { model: Policy, owner: IOwner }): Promise<IMessageResponse<Policy>> => {
                try {
                    const { model, owner } = msg;
                    let policy = await this.policyEngine.createPolicy(model, owner, emptyNotifier(), logger);
                    policy = await PolicyImportExportHelper.updatePolicyComponents(policy, logger);
                    return new MessageResponse(policy);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.CREATE_POLICIES_ASYNC,
            async (msg: { model: Policy, owner: IOwner, task: any }): Promise<IMessageResponse<any>> => {
                const { model, owner, task } = msg;
                const notifier = await initNotifier(task);
                RunFunctionAsync(async () => {
                    let policy = await this.policyEngine.createPolicy(model, owner, notifier, logger);
                    policy = await PolicyImportExportHelper.updatePolicyComponents(policy, logger);
                    notifier.result(policy.id);
                }, async (error) => {
                    notifier.error(error);
                });
                return new MessageResponse(task);
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.CLONE_POLICY_ASYNC,
            async (msg: { policyId: string, model: Policy, owner: IOwner, task: any }): Promise<IMessageResponse<any>> => {
                const { policyId, model, owner, task } = msg;
                const notifier = await initNotifier(task);
                RunFunctionAsync(async () => {
                    const result = await this.policyEngine.clonePolicy(policyId, model, owner, notifier, logger);
                    if (result?.errors?.length) {
                        const message = `Failed to clone schemas: ${JSON.stringify(result.errors.map(e => e.name))}`;
                        notifier.error(message);
                        await logger.warn(message, ['GUARDIAN_SERVICE']);
                        return;
                    }
                    notifier.result(result.policy.id);
                }, async (error) => {
                    notifier.error(error);
                });
                return new MessageResponse(task);
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.DELETE_POLICY_ASYNC,
            async (msg: { policyId: string, owner: IOwner, task: any }): Promise<IMessageResponse<any>> => {
                const { policyId, owner, task } = msg;
                const notifier = await initNotifier(task);
                RunFunctionAsync(async () => {
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'delete');
                    if (policy.status === PolicyType.DEMO) {
                        notifier.result(await this.policyEngine.deleteDemoPolicy(policy, owner, notifier, logger));
                    } else {
                        notifier.result(await this.policyEngine.deletePolicy(policy, owner, notifier, logger));
                    }
                }, async (error) => {
                    notifier.error(error);
                });
                return new MessageResponse(task);
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.SAVE_POLICIES,
            async (msg: { policyId: string, model: Policy, owner: IOwner }): Promise<IMessageResponse<Policy>> => {
                try {
                    const { policyId, model, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'update');

                    if (policy.status !== PolicyType.DRAFT) {
                        throw new Error('Policy is not in draft status.');
                    }
                    let result = await DatabaseServer.updatePolicyConfig(policyId, model);
                    result = await PolicyImportExportHelper.updatePolicyComponents(result, logger);
                    return new MessageResponse(result);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.PUBLISH_POLICIES,
            async (msg: { policyId: string, model: any, owner: IOwner }): Promise<IMessageResponse<any>> => {
                try {
                    const { model, policyId, owner } = msg;
                    if (!model || !model.policyVersion) {
                        throw new Error('Policy version in body is empty');
                    }
                    const result = await this.policyEngine.validateAndPublishPolicy(model, policyId, owner, emptyNotifier(), logger);
                    return new MessageResponse({
                        isValid: result.isValid,
                        errors: result.errors,
                    });
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.PUBLISH_POLICIES_ASYNC,
            async (msg: { policyId: string, model: any, owner: IOwner, task: any }): Promise<IMessageResponse<any>> => {
                const { model, policyId, owner, task } = msg;
                const notifier = await initNotifier(task);

                RunFunctionAsync(async () => {
                    if (!model || !model.policyVersion) {
                        throw new Error('Policy version in body is empty');
                    }
                    const result = await this.policyEngine.validateAndPublishPolicy(model, policyId, owner, notifier, logger);
                    notifier.result(result);
                }, async (error) => {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    notifier.error(error);
                });

                return new MessageResponse(task);
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.DRY_RUN_POLICIES,
            async (msg: { policyId: string, owner: IOwner }): Promise<IMessageResponse<any>> => {
                try {
                    const { policyId, owner } = msg;

                    const model = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(model, owner, 'publish');

                    if (!model.config) {
                        throw new Error('The policy is empty');
                    }
                    if (model.status === PolicyType.PUBLISH) {
                        throw new Error(`Policy published`);
                    }
                    if (model.status === PolicyType.DISCONTINUED) {
                        throw new Error(`Policy is discontinued`);
                    }
                    if (model.status === PolicyType.DRY_RUN) {
                        throw new Error(`Policy already in Dry Run`);
                    }
                    if (model.status === PolicyType.PUBLISH_ERROR) {
                        throw new Error(`Failed policy cannot be started in dry run mode`);
                    }
                    if (model.status === PolicyType.DEMO) {
                        throw new Error(`Policy imported in demo mode`);
                    }

                    const errors = await this.policyEngine.validateModel(policyId);
                    const isValid = !errors.blocks.some(block => !block.isValid);
                    if (isValid) {
                        const newPolicy = await this.policyEngine.dryRunPolicy(model, owner, 'Dry Run', false, logger);
                        await this.policyEngine.generateModel(newPolicy.id.toString());
                    }

                    return new MessageResponse({
                        isValid,
                        errors
                    });
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.DISCONTINUE_POLICY,
            async (msg: { policyId: string, owner: IOwner, date: any }): Promise<IMessageResponse<boolean>> => {
                try {
                    const { policyId, owner, date } = msg;

                    const model = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(model, owner, 'discontinue');

                    if (model.status !== PolicyType.PUBLISH) {
                        throw new Error(`Policy is not published`);
                    }

                    const root = await this.users.getHederaAccount(owner.creator);
                    const messageServer = new MessageServer(root.hederaAccountId, root.hederaAccountKey, root.signOptions);
                    let message: PolicyMessage;
                    if (date) {
                        const _date = new Date(date);
                        _date.setHours(0, 0, 0, 0);
                        const now = new Date();
                        if (_date.getTime() < now.getTime()) {
                            throw new Error('Date must be more than today');
                        }
                        model.discontinuedDate = _date;
                        message = new PolicyMessage(MessageType.Policy, MessageAction.DeferredDiscontinuePolicy);
                    } else {
                        model.status = PolicyType.DISCONTINUED;
                        model.discontinuedDate = new Date();
                        message = new PolicyMessage(MessageType.Policy, MessageAction.DiscontinuePolicy);
                    }
                    message.setDocument(model);
                    const topic = await TopicConfig.fromObject(await DatabaseServer.getTopicById(model.topicId), true);
                    await messageServer
                        .setTopicObject(topic)
                        .sendMessage(message);
                    await DatabaseServer.updatePolicy(model);

                    await new GuardiansService().sendPolicyMessage(PolicyEvents.REFRESH_MODEL, policyId, {});

                    return new MessageResponse(true);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.DRAFT_POLICIES,
            async (msg: { policyId: string, owner: IOwner }): Promise<IMessageResponse<boolean>> => {
                try {
                    const { policyId, owner } = msg;

                    const model = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(model, owner, 'edit');

                    if (!model.config) {
                        throw new Error('The policy is empty');
                    }
                    if (model.status === PolicyType.PUBLISH) {
                        throw new Error(`Policy published`);
                    }
                    if (model.status === PolicyType.DISCONTINUED) {
                        throw new Error(`Policy is discontinued`);
                    }
                    if (model.status === PolicyType.DRAFT) {
                        throw new Error(`Policy already in draft`);
                    }
                    if (model.status === PolicyType.DEMO) {
                        throw new Error(`Policy imported in demo mode`);
                    }

                    model.status = PolicyType.DRAFT;
                    model.version = '';

                    let retVal = await DatabaseServer.updatePolicy(model);
                    retVal = await PolicyImportExportHelper.updatePolicyComponents(retVal, logger);

                    await this.policyEngine.destroyModel(model.id.toString());

                    const databaseServer = new DatabaseServer(model.id.toString());
                    await databaseServer.clear(true);

                    return new MessageResponse(true);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.VALIDATE_POLICIES,
            async (msg: { policyId: string, model: Policy, owner: IOwner }): Promise<IMessageResponse<any>> => {
                try {
                    const { model } = msg;
                    const results = await this.policyEngine.validateModel(model);
                    return new MessageResponse({
                        results,
                        policy: model
                    });
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });
        //#endregion

        //#region Export endpoints
        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_EXPORT_FILE,
            async (msg: { policyId: string, owner: IOwner }): Promise<IMessageResponse<any>> => {
                try {
                    const { policyId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    const zip = await PolicyImportExport.generate(policy);
                    const file = await zip.generateAsync({
                        type: 'arraybuffer',
                        compression: 'DEFLATE',
                        compressionOptions: {
                            level: 3,
                        },
                    });
                    console.log('File size: ' + file.byteLength);
                    return new BinaryMessageResponse(file);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_EXPORT_MESSAGE,
            async (msg: { policyId: string, owner: IOwner }): Promise<IMessageResponse<any>> => {
                try {
                    const { policyId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    return new MessageResponse({
                        id: policy.id,
                        name: policy.name,
                        description: policy.description,
                        version: policy.version,
                        messageId: policy.messageId,
                        owner: policy.owner
                    });
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_EXPORT_XLSX,
            async (msg: { policyId: string, owner: IOwner }): Promise<IMessageResponse<any>> => {
                try {
                    const { policyId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    const { schemas, tools, toolSchemas } = await PolicyImportExport.loadAllSchemas(policy);
                    const buffer = await JsonToXlsx.generate(schemas, tools, toolSchemas);
                    return new BinaryMessageResponse(buffer);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });
        //#endregion

        //#region Import endpoints
        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_IMPORT_FILE_PREVIEW,
            async (msg: { zip: any, owner: IOwner }): Promise<IMessageResponse<any>> => {
                try {
                    const { zip, owner } = msg;
                    if (!zip) {
                        throw new Error('file in body is empty');
                    }
                    const policyToImport = await PolicyImportExport.parseZipFile(Buffer.from(zip.data), true);
                    const hash = await this.createHashByFile(policyToImport, logger);
                    const filters = await this.policyEngine.addAccessFilters({ hash }, owner);
                    const similarPolicies = await DatabaseServer.getListOfPolicies(filters);
                    (policyToImport as any).similar = similarPolicies;
                    return new MessageResponse(policyToImport);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_IMPORT_FILE,
            async (msg: {
                zip: any,
                owner: IOwner,
                versionOfTopicId: string,
                metadata: any,
                demo: boolean
            }): Promise<IMessageResponse<boolean>> => {
                try {
                    const { zip, owner, versionOfTopicId, metadata, demo } = msg;
                    if (!zip) {
                        throw new Error('file in body is empty');
                    }
                    await logger.info(`Import policy by file`, ['GUARDIAN_SERVICE']);
                    const policyToImport = await PolicyImportExport.parseZipFile(Buffer.from(zip.data), true);
                    const result = await PolicyImportExportHelper.importPolicy(
                        policyToImport,
                        owner,
                        versionOfTopicId,
                        logger,
                        null,
                        metadata,
                        demo
                    );
                    if (result?.errors?.length) {
                        const message = PolicyImportExportHelper.errorsMessage(result.errors);
                        await logger.warn(message, ['GUARDIAN_SERVICE']);
                        return new MessageError(message);
                    }
                    if (demo) {
                        await this.policyEngine.startDemo(result.policy, owner, logger);
                    }
                    return new MessageResponse(true);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_IMPORT_FILE_ASYNC,
            async (msg: {
                zip: any,
                owner: IOwner,
                versionOfTopicId: string,
                metadata: any,
                demo: boolean,
                task: any
            }): Promise<IMessageResponse<any>> => {
                const { zip, owner, versionOfTopicId, task, metadata, demo } = msg;
                const notifier = await initNotifier(task);

                RunFunctionAsync(async () => {
                    if (!zip) {
                        throw new Error('file in body is empty');
                    }
                    await logger.info(`Import policy by file`, ['GUARDIAN_SERVICE']);
                    notifier.start('File parsing');
                    const policyToImport = await PolicyImportExport.parseZipFile(Buffer.from(zip.data), true);
                    notifier.completed();
                    const result = await PolicyImportExportHelper.importPolicy(
                        policyToImport,
                        owner,
                        versionOfTopicId,
                        logger,
                        null,
                        metadata,
                        demo,
                        notifier
                    );
                    if (result?.errors?.length) {
                        const message = PolicyImportExportHelper.errorsMessage(result.errors);
                        notifier.error(message);
                        await logger.warn(message, ['GUARDIAN_SERVICE']);
                        return;
                    }
                    if (demo) {
                        await this.policyEngine.startDemo(result.policy, owner, logger, notifier);
                    }
                    notifier.result({
                        policyId: result.policy.id,
                        errors: result.errors
                    });
                }, async (error) => {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    notifier.error(error);
                });
                return new MessageResponse(task);
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_IMPORT_MESSAGE_PREVIEW,
            async (msg: { messageId: string, owner: IOwner }): Promise<IMessageResponse<any>> => {
                try {
                    const { messageId, owner } = msg;
                    const policyToImport = await this.policyEngine
                        .preparePolicyPreviewMessage(messageId, owner, emptyNotifier(), logger);
                    const hash = await this.createHashByFile(policyToImport, logger);
                    const filters = await this.policyEngine.addAccessFilters({ hash }, owner);
                    const similarPolicies = await DatabaseServer.getListOfPolicies(filters);
                    policyToImport.similar = similarPolicies;
                    return new MessageResponse(policyToImport);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_IMPORT_MESSAGE_PREVIEW_ASYNC,
            async (msg: {
                messageId: string,
                owner: IOwner,
                task: any
            }): Promise<IMessageResponse<any>> => {
                const { messageId, owner, task } = msg;
                const notifier = await initNotifier(task);

                RunFunctionAsync(async () => {
                    const policyToImport = await this.policyEngine.preparePolicyPreviewMessage(messageId, owner, notifier, logger);
                    const hash = await this.createHashByFile(policyToImport, logger);
                    const filters = await this.policyEngine.addAccessFilters({ hash }, owner);
                    const similarPolicies = await DatabaseServer.getListOfPolicies(filters);
                    policyToImport.similar = similarPolicies;
                    notifier.result(policyToImport);
                }, async (error) => {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    notifier.error(error);
                });
                return new MessageResponse(task);
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_IMPORT_MESSAGE,
            async (msg: {
                messageId: string,
                owner: IOwner,
                versionOfTopicId: string,
                metadata: any,
                demo: boolean
            }): Promise<IMessageResponse<boolean>> => {
                try {
                    const { messageId, owner, versionOfTopicId, metadata, demo } = msg;
                    if (!messageId) {
                        throw new Error('Policy ID in body is empty');
                    }
                    const root = await this.users.getHederaAccount(owner.creator);
                    const result = await this.policyEngine
                        .importPolicyMessage(messageId, owner, root, versionOfTopicId, logger, metadata, demo);
                    if (result?.errors?.length) {
                        const message = PolicyImportExportHelper.errorsMessage(result.errors);
                        await logger.warn(message, ['GUARDIAN_SERVICE']);
                        return new MessageError(message);
                    }
                    if (demo) {
                        await this.policyEngine.startDemo(result.policy, owner, logger);
                    }
                    return new MessageResponse(true);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_IMPORT_MESSAGE_ASYNC,
            async (msg: {
                messageId: string,
                owner: IOwner,
                versionOfTopicId: string,
                metadata: any,
                demo: boolean,
                task: any
            }): Promise<IMessageResponse<boolean>> => {
                const { messageId, owner, versionOfTopicId, task, metadata, demo } = msg;
                const notifier = await initNotifier(task);

                RunFunctionAsync(async () => {
                    try {
                        if (!messageId) {
                            throw new Error('Policy ID in body is empty');
                        }
                        notifier.start('Resolve Hedera account');
                        const root = await this.users.getHederaAccount(owner.creator);
                        notifier.completed();
                        const result = await this.policyEngine
                            .importPolicyMessage(messageId, owner, root, versionOfTopicId, logger, metadata, demo, notifier);
                        if (result?.errors?.length) {
                            const message = PolicyImportExportHelper.errorsMessage(result.errors);
                            notifier.error(message);
                            await logger.warn(message, ['GUARDIAN_SERVICE']);
                            return;
                        }
                        if (demo) {
                            await this.policyEngine.startDemo(result.policy, owner, logger, notifier);
                        }
                        notifier.result({
                            policyId: result.policy.id,
                            errors: result.errors
                        });
                    } catch (error) {
                        await logger.error(error, ['GUARDIAN_SERVICE']);
                        notifier.error(error);
                    }
                });
                return new MessageResponse(task);
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_IMPORT_XLSX_FILE_PREVIEW,
            async (msg: { xlsx: any, owner: IOwner }): Promise<IMessageResponse<any>> => {
                try {
                    const { xlsx } = msg;
                    if (!xlsx) {
                        throw new Error('file in body is empty');
                    }
                    const xlsxResult = await XlsxToJson.parse(Buffer.from(xlsx.data));
                    for (const toolId of xlsxResult.getToolIds()) {
                        try {
                            const tool = await previewToolByMessage(toolId.messageId);
                            xlsxResult.updateTool(tool.tool, tool.schemas);
                        } catch (error) {
                            xlsxResult.addErrors([{
                                text: `Failed to load tool (${toolId.messageId})`,
                                worksheet: toolId.worksheet,
                                message: error?.toString()
                            }]);
                        }
                    }
                    xlsxResult.updateSchemas(false);
                    GenerateBlocks.generate(xlsxResult);
                    return new MessageResponse(xlsxResult.toJson());
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_IMPORT_XLSX,
            async (msg: { xlsx: any, policyId: string, owner: IOwner }): Promise<IMessageResponse<any>> => {
                try {
                    const { xlsx, policyId, owner } = msg;
                    const notifier = emptyNotifier();
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'create');
                    if (!xlsx) {
                        throw new Error('file in body is empty');
                    }
                    const root = await this.users.getHederaAccount(owner.creator);
                    const xlsxResult = await XlsxToJson.parse(Buffer.from(xlsx.data));
                    const { tools, errors } = await importSubTools(root, xlsxResult.getToolIds(), owner, notifier);
                    for (const tool of tools) {
                        const subSchemas = await DatabaseServer.getSchemas({ topicId: tool.topicId });
                        xlsxResult.updateTool(tool, subSchemas);
                    }
                    xlsxResult.updateSchemas(false);
                    xlsxResult.updatePolicy(policy);
                    xlsxResult.addErrors(errors);
                    GenerateBlocks.generate(xlsxResult);
                    const category = await getSchemaCategory(policy.topicId);
                    const result = await SchemaImportExportHelper.importSchemaByFiles(
                        xlsxResult.schemas,
                        owner,
                        {
                            category,
                            topicId: policy.topicId,
                            skipGenerateId: true
                        },
                        notifier
                    );
                    await PolicyImportExportHelper.updatePolicyComponents(policy, logger);
                    return new MessageResponse({
                        policyId: policy.id,
                        errors: result.errors
                    });
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.POLICY_IMPORT_XLSX_ASYNC,
            async (msg: {
                xlsx: any,
                policyId: string,
                owner: IOwner,
                task: any
            }): Promise<IMessageResponse<any>> => {
                const { xlsx, policyId, owner, task } = msg;
                const notifier = await initNotifier(task);

                RunFunctionAsync(async () => {
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'create');
                    if (!xlsx) {
                        throw new Error('file in body is empty');
                    }
                    await logger.info(`Import policy by xlsx`, ['GUARDIAN_SERVICE']);
                    const root = await this.users.getHederaAccount(owner.creator);
                    notifier.start('File parsing');
                    const xlsxResult = await XlsxToJson.parse(Buffer.from(xlsx.data));
                    const { tools, errors } = await importSubTools(root, xlsxResult.getToolIds(), owner, notifier);
                    for (const tool of tools) {
                        const subSchemas = await DatabaseServer.getSchemas({ topicId: tool.topicId });
                        xlsxResult.updateTool(tool, subSchemas);
                    }
                    xlsxResult.updateSchemas(false);
                    xlsxResult.updatePolicy(policy);
                    xlsxResult.addErrors(errors);
                    GenerateBlocks.generate(xlsxResult);
                    const category = await getSchemaCategory(policy.topicId);
                    const result = await SchemaImportExportHelper.importSchemaByFiles(
                        xlsxResult.schemas,
                        owner,
                        {
                            category,
                            topicId: policy.topicId,
                            skipGenerateId: true
                        },
                        notifier
                    );
                    await PolicyImportExportHelper.updatePolicyComponents(policy, logger);
                    notifier.result({
                        policyId: policy.id,
                        errors: result.errors
                    });
                }, async (error) => {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    notifier.error(error);
                });
                return new MessageResponse(task);
            });
        //#endregion

        //#region DRY RUN endpoints
        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_VIRTUAL_USERS,
            async (msg: { policyId: string, owner: IOwner }) => {
                try {
                    const { policyId, owner } = msg;
                    const model = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(model, owner, 'read');
                    if (!PolicyHelper.isDryRunMode(model)) {
                        throw new Error(`Policy is not in Dry Run`);
                    }
                    const users = await DatabaseServer.getVirtualUsers(policyId);
                    return new MessageResponse(users);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.CREATE_VIRTUAL_USER,
            async (msg: { policyId: string, owner: IOwner }) => {
                try {
                    const { policyId, owner } = msg;

                    const model = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(model, owner, 'read');
                    if (!PolicyHelper.isDryRunMode(model)) {
                        throw new Error(`Policy is not in Dry Run`);
                    }

                    const topic = await DatabaseServer.getTopicByType(owner.owner, TopicType.UserTopic);
                    const newPrivateKey = PrivateKey.generate();
                    const newAccountId = new AccountId(Date.now());

                    const vcHelper = new VcHelper();
                    const didObject = await vcHelper.generateNewDid(topic.topicId, newPrivateKey);
                    const did = didObject.getDid();
                    const document = didObject.getDocument();

                    const count = await DatabaseServer.getVirtualUsers(policyId);
                    const username = `Virtual User ${count.length}`;

                    await DatabaseServer.createVirtualUser(
                        policyId,
                        username,
                        did,
                        newAccountId.toString(),
                        newPrivateKey.toString(),
                        false
                    );

                    const instanceDB = new DatabaseServer(policyId);
                    const keys = didObject.getPrivateKeys();
                    const verificationMethods = {};
                    for (const item of keys) {
                        const { id, type, key } = item;
                        verificationMethods[type] = id;
                        await instanceDB.setVirtualKey(did, id, key);
                    }
                    await instanceDB.setVirtualKey(did, did, newPrivateKey.toString());
                    await instanceDB.saveDid({ did, document, verificationMethods });

                    await (new GuardiansService())
                        .sendPolicyMessage(PolicyEvents.CREATE_VIRTUAL_USER, policyId, {
                            did,
                            data: {
                                accountId: newAccountId.toString(),
                                document
                            }
                        });

                    const users = await DatabaseServer.getVirtualUsers(policyId);
                    return new MessageResponse(users);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.SET_VIRTUAL_USER,
            async (msg: { policyId: string, virtualDID: string, owner: IOwner }) => {
                try {
                    const { policyId, virtualDID, owner } = msg;

                    const model = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(model, owner, 'read');
                    if (!PolicyHelper.isDryRunMode(model)) {
                        throw new Error(`Policy is not in Dry Run`);
                    }

                    await DatabaseServer.setVirtualUser(policyId, virtualDID)
                    const users = await DatabaseServer.getVirtualUsers(policyId);

                    await (new GuardiansService())
                        .sendPolicyMessage(PolicyEvents.SET_VIRTUAL_USER, policyId, { did: virtualDID });

                    return new MessageResponse(users);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.RESTART_DRY_RUN,
            async (msg: { policyId: string, owner: IOwner }) => {
                try {
                    const { policyId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    if (!policy.config) {
                        throw new Error('The policy is empty');
                    }
                    if (!PolicyHelper.isDryRunMode(policy)) {
                        throw new Error(`Policy is not in Dry Run`);
                    }

                    await DatabaseServer.clearDryRun(policyId, false);
                    const users = await DatabaseServer.getVirtualUsers(policyId);
                    await DatabaseServer.setVirtualUser(policyId, users[0]?.did);
                    const filters = await this.policyEngine.addAccessFilters({}, owner);
                    const policies = (await DatabaseServer.getListOfPolicies(filters));
                    return new MessageResponse({ policies });
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.CREATE_SAVEPOINT,
            async (msg: { policyId: string, owner: IOwner }) => {
                try {
                    const { policyId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    if (!policy.config) {
                        throw new Error('The policy is empty');
                    }
                    if (!PolicyHelper.isDryRunMode(policy)) {
                        throw new Error(`Policy is not in Dry Run`);
                    }

                    await DatabaseServer.createSavepoint(policyId);
                    await DatabaseServer.copyStates(policyId);
                    // const users = await DatabaseServer.getVirtualUsers(policyId);
                    // await DatabaseServer.setVirtualUser(policyId, users[0]?.did);
                    // const filters = await this.policyEngine.addAccessFilters({}, owner);
                    // const policies = (await DatabaseServer.getListOfPolicies(filters));
                    console.log('Create savepoint');
                    return new MessageResponse({});
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.DELETE_SAVEPOINT,
            async (msg: { policyId: string, owner: IOwner }) => {
                try {
                    const { policyId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    if (!policy.config) {
                        throw new Error('The policy is empty');
                    }
                    if (!PolicyHelper.isDryRunMode(policy)) {
                        throw new Error(`Policy is not in Dry Run`);
                    }

                    await DatabaseServer.restoreSavepoint(policyId);
                    // const users = await DatabaseServer.getVirtualUsers(policyId);
                    // await DatabaseServer.setVirtualUser(policyId, users[0]?.did);
                    // const filters = await this.policyEngine.addAccessFilters({}, owner);
                    // const policies = (await DatabaseServer.getListOfPolicies(filters));
                    console.log('Delete savepoint');
                    return new MessageResponse({});
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.RESTORE_SAVEPOINT,
            async (msg: { policyId: string, owner: IOwner }) => {
                try {
                    const { policyId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    if (!policy.config) {
                        throw new Error('The policy is empty');
                    }
                    if (!PolicyHelper.isDryRunMode(policy)) {
                        throw new Error(`Policy is not in Dry Run`);
                    }

                    await DatabaseServer.restoreSavepoint(policyId);
                    await DatabaseServer.restoreStates(policyId);
                    // const users = await DatabaseServer.getVirtualUsers(policyId);
                    // await DatabaseServer.setVirtualUser(policyId, users[0]?.did);
                    // const filters = await this.policyEngine.addAccessFilters({}, owner);
                    // const policies = (await DatabaseServer.getListOfPolicies(filters));
                    console.log('Restore savepoint');
                    return new MessageResponse({});
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_SAVEPOINT,
                                           async (msg: {policyId: string, owner: IOwner}) => {
                                               try {
                                                   const {policyId, owner} = msg;
                                                   const policy = await DatabaseServer.getPolicyById(policyId);
                                                   await this.policyEngine.accessPolicy(policy, owner, 'read');
                                                   if (!policy.config) {
                                                       throw new Error('The policy is empty');
                                                   }
                                                   if (!PolicyHelper.isDryRunMode(policy)) {
                                                       throw new Error(`Policy is not in Dry Run`);
                                                   }

                                                   const state = await DatabaseServer.getSavepointSate(policyId);
                                                   // const users = await DatabaseServer.getVirtualUsers(policyId);
                                                   // await DatabaseServer.setVirtualUser(policyId, users[0]?.did);
                                                   // const filters = await this.policyEngine.addAccessFilters({}, owner);
                                                   // const policies = (await DatabaseServer.getListOfPolicies(filters));
                                                   console.log('Restore savepoint');
                                                   return new MessageResponse({state});
                                               } catch (error) {
                                                   await logger.error(error, ['GUARDIAN_SERVICE']);
                                                   return new MessageError(error);
                                               }
                                           });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_VIRTUAL_DOCUMENTS,
            async (msg: {
                policyId: string,
                type: string,
                owner: IOwner,
                pageIndex: string,
                pageSize: string
            }) => {
                try {
                    const { policyId, type, owner, pageIndex, pageSize } = msg;
                    const model = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(model, owner, 'read');
                    if (!PolicyHelper.isDryRunMode(model)) {
                        throw new Error(`Policy is not in Dry Run`);
                    }
                    const documents = await DatabaseServer
                        .getVirtualDocuments(policyId, type, pageIndex, pageSize);
                    return new MessageResponse(documents);
                } catch (error) {
                    return new MessageError(error);
                }
            });
        //#endregion

        //#region Migrate data endpoints
        this.channel.getMessages<any, any>(PolicyEngineEvents.MIGRATE_DATA,
            async (msg: { migrationConfig: any, owner: IOwner }) => {
                try {
                    const { migrationConfig, owner } = msg;
                    const migrationErrors = await PolicyDataMigrator.migrate(
                        owner.owner,
                        migrationConfig,
                        emptyNotifier()
                    );
                    await this.policyEngine.regenerateModel(
                        migrationConfig.policies.dst
                    );
                    if (migrationErrors.length > 0) {
                        await logger.warn(
                            migrationErrors
                                .map((error) => `${error.id}: ${error.message}`)
                                .join('\r\n'),
                            ['GUARDIAN_SERVICE']
                        );
                    }
                    return new MessageResponse(migrationErrors);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.MIGRATE_DATA_ASYNC,
            async (msg: { migrationConfig: any, owner: IOwner, task: any }) => {
                try {
                    const { migrationConfig, owner, task } = msg;
                    const notifier = await initNotifier(task);
                    RunFunctionAsync(
                        async () => {
                            const migrationErrors =
                                await PolicyDataMigrator.migrate(
                                    owner.owner,
                                    migrationConfig,
                                    notifier
                                );
                            await this.policyEngine.regenerateModel(
                                migrationConfig.policies.dst
                            );
                            if (migrationErrors.length > 0) {
                                await logger.warn(
                                    migrationErrors
                                        .map(
                                            (error) =>
                                                `${error.id}: ${error.message}`
                                        )
                                        .join('\r\n'),
                                    ['GUARDIAN_SERVICE']
                                );
                            }
                            notifier.result(migrationErrors);
                        },
                        async (error) => {
                            notifier.error(error);
                        }
                    );
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.DOWNLOAD_VIRTUAL_KEYS,
            async (msg: { policyId: string, owner: IOwner }) => {
                try {
                    const { policyId, owner } = msg;
                    const policy = await DatabaseServer.getPolicy({
                        id: policyId,
                        status: {
                            $in: [
                                PolicyType.DRY_RUN,
                                PolicyType.DEMO
                            ]
                        }
                    });
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    const zip = await PolicyDataImportExport.exportVirtualKeys(owner, policy.id);
                    const zippedData = await zip.generateAsync({
                        type: 'arraybuffer',
                        compression: 'DEFLATE',
                        compressionOptions: {
                            level: 3,
                        },
                    });
                    return new BinaryMessageResponse(zippedData);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.UPLOAD_VIRTUAL_KEYS,
            async (msg: { policyId: string, data: any, owner: IOwner }) => {
                try {
                    const { policyId, data, owner } = msg;
                    const policy = await DatabaseServer.getPolicy({
                        id: policyId,
                        status: {
                            $in: [
                                PolicyType.DRY_RUN,
                                PolicyType.DEMO
                            ]
                        }
                    });
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    await PolicyDataImportExport.importVirtualKeys(
                        Buffer.from(data),
                        policy.id
                    );
                    return new MessageResponse(null);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.DOWNLOAD_POLICY_DATA,
            async (msg: { policyId: string, owner: IOwner }) => {
                try {
                    const { policyId, owner } = msg;
                    const policy = await DatabaseServer.getPolicy({
                        id: policyId,
                        status: {
                            $in: [
                                PolicyType.DRY_RUN,
                                PolicyType.PUBLISH,
                                PolicyType.DISCONTINUED,
                                PolicyType.DEMO
                            ]
                        },
                    });
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    const policyDataExportHelper = new PolicyDataImportExport(policy);
                    const zip = await policyDataExportHelper.exportData();
                    const zippedData = await zip.generateAsync({
                        type: 'arraybuffer',
                        compression: 'DEFLATE',
                        compressionOptions: {
                            level: 3,
                        },
                    });
                    return new BinaryMessageResponse(zippedData);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.UPLOAD_POLICY_DATA,
            async (msg: { data: any, owner: IOwner }) => {
                try {
                    const { data, owner } = msg;
                    if (!data) {
                        throw new Error('Invalid policy data');
                    }
                    return new MessageResponse(
                        await PolicyDataImportExport.importData(owner.owner, Buffer.from(msg?.data))
                    );
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_POLICY_DOCUMENTS,
            async (msg: {
                owner: IOwner,
                policyId: string,
                includeDocument: boolean,
                type: DocumentType,
                pageIndex: string,
                pageSize: string
            }) => {
                try {
                    const {
                        owner,
                        policyId,
                        includeDocument,
                        type,
                        pageIndex,
                        pageSize,
                    } = msg;

                    const parsedPageSize = parseInt(pageSize, 10);
                    const parsedPageIndex = parseInt(pageIndex, 10);
                    const paginationNeeded =
                        Number.isInteger(parsedPageSize) &&
                        Number.isInteger(parsedPageIndex);

                    const filters: any = {};
                    const otherOptions: any = {
                        fields: ['id', 'owner'],
                    };
                    if (includeDocument) {
                        otherOptions.fields.push('documentFileId');
                    }
                    if (paginationNeeded) {
                        otherOptions.limit = parsedPageSize;
                        otherOptions.offset = parsedPageIndex * parsedPageSize;
                    }

                    const userPolicy = await DatabaseServer.getPolicyCache({
                        id: policyId,
                        userId: owner.creator,
                    });
                    if (userPolicy) {
                        otherOptions.fields.push('oldId');
                        filters.cachePolicyId = policyId;
                        if (type === DocumentType.VC) {
                            filters.cacheCollection = 'vcs';
                            otherOptions.fields.push('schema');
                            filters.schema = {
                                $ne: null,
                            };
                            filters.type = {
                                $ne: DocumentCategoryType.USER_ROLE,
                            };
                            return new MessageResponse(
                                await DatabaseServer.getAndCountPolicyCacheData(
                                    filters,
                                    otherOptions
                                )
                            );
                        } else if (type === DocumentType.VP) {
                            filters.cacheCollection = 'vps';
                            return new MessageResponse(
                                await DatabaseServer.getAndCountPolicyCacheData(
                                    filters,
                                    otherOptions
                                )
                            );
                        } else {
                            throw new Error(`Unknown type: ${type}`);
                        }
                    }

                    const model = await DatabaseServer.getPolicy({ id: policyId });
                    await this.policyEngine.accessPolicy(model, owner, 'read');
                    if (!PolicyHelper.isRun(model)) {
                        throw new Error(`Policy is not running`);
                    }

                    filters.policyId = policyId;

                    let loader: PolicyDataLoader;
                    if (type === DocumentType.VC) {
                        otherOptions.fields.push('schema');
                        filters.schema = {
                            $ne: null,
                        };
                        filters.type = {
                            $ne: DocumentCategoryType.USER_ROLE,
                        };
                        loader = new VcDocumentLoader(
                            model.id,
                            model.topicId,
                            model.instanceTopicId,
                            PolicyHelper.isDryRunMode(model)
                        );
                    } else if (type === DocumentType.VP) {
                        loader = new VpDocumentLoader(
                            model.id,
                            model.topicId,
                            model.instanceTopicId,
                            PolicyHelper.isDryRunMode(model)
                        );
                    } else {
                        throw new Error(`Unknown type: ${type}`);
                    }
                    return new MessageResponse([
                        await loader.get(filters, otherOptions),
                        await loader.get(filters, null, true),
                    ]);
                } catch (error) {
                    return new MessageError(error);
                }
            });
        //#endregion

        //#region Tests
        this.channel.getMessages<any, any>(PolicyEngineEvents.ADD_POLICY_TEST,
            async (msg: { policyId: string, file: any, owner: IOwner }) => {
                try {
                    const { policyId, file, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    if (PolicyHelper.isPublishMode(policy)) {
                        throw new Error(`Policy is published`);
                    }
                    const buffer = Buffer.from(file.buffer);
                    const recordToImport = await RecordImportExport.parseZipFile(buffer);
                    const test = await DatabaseServer.createPolicyTest(
                        {
                            uuid: GenerateUUIDv4(),
                            name: file.filename.split('.')[0],
                            policyId,
                            owner: owner.creator,
                            status: PolicyTestStatus.New,
                            duration: recordToImport.duration,
                            progress: 0,
                            date: null,
                            result: null,
                            error: null,
                            resultId: null
                        },
                        buffer
                    );
                    return new MessageResponse(test);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_POLICY_TEST,
            async (msg: { policyId: string, testId: string, owner: IOwner }) => {
                try {
                    const { policyId, testId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    const test = await DatabaseServer.getPolicyTest(policyId, testId);
                    if (!test) {
                        return new MessageError('Policy test does not exist.', 404);
                    }
                    return new MessageResponse(test);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.START_POLICY_TEST,
            async (msg: { policyId: string, testId: string, owner: IOwner }) => {
                try {
                    const { policyId, testId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    if (!PolicyHelper.isDryRunMode(policy)) {
                        throw new Error(`Policy is not in Dry Run`);
                    }
                    const test = await DatabaseServer.getPolicyTest(policyId, testId);
                    if (!test) {
                        return new MessageError('Policy test does not exist.', 404);
                    }
                    const zip = await DatabaseServer.loadFile(test.file);
                    if (!zip) {
                        return new MessageError('Policy test does not exist.', 404);
                    }
                    const active = await DatabaseServer.getPolicyTestsByStatus(policyId, PolicyTestStatus.Running);
                    if (active.length) {
                        return new MessageError('Policy test is already running.', 500);
                    }

                    await DatabaseServer.clearDryRun(policyId, false);
                    const users = await DatabaseServer.getVirtualUsers(policyId);
                    await DatabaseServer.setVirtualUser(policyId, users[0]?.did);

                    const options = { mode: 'test' };
                    const recordToImport = await RecordImportExport.parseZipFile(Buffer.from(zip));
                    const guardiansService = new GuardiansService();
                    const recordId: string = await guardiansService
                        .sendPolicyMessage(PolicyEvents.RUN_RECORD, policyId, {
                            records: recordToImport.records,
                            results: recordToImport.results,
                            options
                        });
                    if (recordId) {
                        test.resultId = recordId;
                        test.duration = recordToImport.duration;
                        test.date = (new Date()).toISOString();
                        test.status = PolicyTestStatus.Running;
                        test.progress = 0;
                        test.result = null;
                        test.error = null;
                        await DatabaseServer.updatePolicyTest(test);
                    }

                    return new MessageResponse(test);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.STOP_POLICY_TEST,
            async (msg: { policyId: string, testId: string, owner: IOwner }) => {
                try {
                    const { policyId, testId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    if (!PolicyHelper.isDryRunMode(policy)) {
                        throw new Error(`Policy is not in Dry Run`);
                    }
                    const test = await DatabaseServer.getPolicyTest(policyId, testId);
                    if (test.status !== PolicyTestStatus.Running) {
                        return new MessageError('Policy test not started.', 500);
                    }

                    const guardiansService = new GuardiansService();
                    const result: string = await guardiansService
                        .sendPolicyMessage(PolicyEvents.STOP_RUNNING, policyId, null);
                    if (result) {
                        test.status = PolicyTestStatus.Stopped;
                        test.progress = 0;
                        test.result = null;
                        test.error = null;
                        test.resultId = null;
                        await DatabaseServer.updatePolicyTest(test);
                    }
                    return new MessageResponse(test);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.DELETE_POLICY_TEST,
            async (msg: { policyId: string, testId: string, owner: IOwner }) => {
                try {
                    const { policyId, testId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    if (PolicyHelper.isPublishMode(policy)) {
                        throw new Error(`Policy is published`);
                    }
                    await DatabaseServer.deletePolicyTest(policyId, testId);
                    return new MessageResponse(true);
                } catch (error) {
                    return new MessageError(error);
                }
            });

        this.channel.getMessages<any, any>(PolicyEngineEvents.GET_POLICY_TEST_DETAILS,
            async (msg: { policyId: string, testId: string, owner: IOwner }) => {
                try {
                    const { policyId, testId, owner } = msg;
                    const policy = await DatabaseServer.getPolicyById(policyId);
                    await this.policyEngine.accessPolicy(policy, owner, 'read');
                    const test = await DatabaseServer.getPolicyTest(policyId, testId);
                    if (!test || !test.result) {
                        return new MessageError('Policy test does not exist.', 404);
                    }
                    const result = await compareResults(test.result.details);
                    return new MessageResponse(result);
                } catch (error) {
                    await logger.error(error, ['GUARDIAN_SERVICE']);
                    return new MessageError(error);
                }
            });
        //#endregion
    }
}
