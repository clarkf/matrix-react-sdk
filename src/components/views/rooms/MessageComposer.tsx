/*
Copyright 2015 - 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React, { createRef, ReactNode } from "react";
import classNames from "classnames";
import { IEventRelation, MatrixEvent } from "matrix-js-sdk/src/models/event";
import { Room } from "matrix-js-sdk/src/models/room";
import { RoomMember } from "matrix-js-sdk/src/models/room-member";
import { EventType } from "matrix-js-sdk/src/@types/event";
import { Optional } from "matrix-events-sdk";
import { THREAD_RELATION_TYPE } from "matrix-js-sdk/src/models/thread";

import { _t } from "../../../languageHandler";
import { MatrixClientPeg } from "../../../MatrixClientPeg";
import dis from "../../../dispatcher/dispatcher";
import { ActionPayload } from "../../../dispatcher/payloads";
import Stickerpicker from "./Stickerpicker";
import { makeRoomPermalink, RoomPermalinkCreator } from "../../../utils/permalinks/Permalinks";
import E2EIcon from "./E2EIcon";
import SettingsStore from "../../../settings/SettingsStore";
import { aboveLeftOf } from "../../structures/ContextMenu";
import AccessibleTooltipButton from "../elements/AccessibleTooltipButton";
import ReplyPreview from "./ReplyPreview";
import { UPDATE_EVENT } from "../../../stores/AsyncStore";
import VoiceRecordComposerTile from "./VoiceRecordComposerTile";
import { VoiceRecordingStore } from "../../../stores/VoiceRecordingStore";
import { RecordingState } from "../../../audio/VoiceRecording";
import Tooltip, { Alignment } from "../elements/Tooltip";
import ResizeNotifier from "../../../utils/ResizeNotifier";
import { E2EStatus } from "../../../utils/ShieldUtils";
import SendMessageComposer, { SendMessageComposer as SendMessageComposerClass } from "./SendMessageComposer";
import { ComposerInsertPayload } from "../../../dispatcher/payloads/ComposerInsertPayload";
import { Action } from "../../../dispatcher/actions";
import EditorModel from "../../../editor/model";
import UIStore, { UI_EVENTS } from "../../../stores/UIStore";
import RoomContext from "../../../contexts/RoomContext";
import { SettingUpdatedPayload } from "../../../dispatcher/payloads/SettingUpdatedPayload";
import MessageComposerButtons from "./MessageComposerButtons";
import { ButtonEvent } from "../elements/AccessibleButton";
import { ViewRoomPayload } from "../../../dispatcher/payloads/ViewRoomPayload";
import { isLocalRoom } from "../../../utils/localRoom/isLocalRoom";
import { Features } from "../../../settings/Settings";
import { VoiceMessageRecording } from "../../../audio/VoiceMessageRecording";
import { SendWysiwygComposer, sendMessage, getConversionFunctions } from "./wysiwyg_composer/";
import { MatrixClientProps, withMatrixClientHOC } from "../../../contexts/MatrixClientContext";
import { setUpVoiceBroadcastPreRecording } from "../../../voice-broadcast/utils/setUpVoiceBroadcastPreRecording";
import { SdkContextClass } from "../../../contexts/SDKContext";

let instanceCount = 0;

interface ISendButtonProps {
    onClick: (ev: ButtonEvent) => void;
    title?: string; // defaults to something generic
}

function SendButton(props: ISendButtonProps) {
    return (
        <AccessibleTooltipButton
            className="mx_MessageComposer_sendMessage"
            onClick={props.onClick}
            title={props.title ?? _t("Send message")}
            data-testid="sendmessagebtn"
        />
    );
}

interface IProps extends MatrixClientProps {
    room: Room;
    resizeNotifier: ResizeNotifier;
    permalinkCreator: RoomPermalinkCreator;
    replyToEvent?: MatrixEvent;
    relation?: IEventRelation;
    e2eStatus?: E2EStatus;
    compact?: boolean;
}

interface IState {
    composerContent: string;
    isComposerEmpty: boolean;
    haveRecording: boolean;
    recordingTimeLeftSeconds?: number;
    me?: RoomMember;
    isMenuOpen: boolean;
    isStickerPickerOpen: boolean;
    showStickersButton: boolean;
    showPollsButton: boolean;
    showVoiceBroadcastButton: boolean;
    isWysiwygLabEnabled: boolean;
    isRichTextEnabled: boolean;
    initialComposerContent: string;
}

export class MessageComposer extends React.Component<IProps, IState> {
    private dispatcherRef?: string;
    private messageComposerInput = createRef<SendMessageComposerClass>();
    private voiceRecordingButton = createRef<VoiceRecordComposerTile>();
    private ref: React.RefObject<HTMLDivElement> = createRef();
    private instanceId: number;

    private _voiceRecording: Optional<VoiceMessageRecording>;

    public static contextType = RoomContext;
    public context!: React.ContextType<typeof RoomContext>;

    public static defaultProps = {
        compact: false,
        showVoiceBroadcastButton: false,
        isRichTextEnabled: true,
    };

    public constructor(props: IProps) {
        super(props);
        VoiceRecordingStore.instance.on(UPDATE_EVENT, this.onVoiceStoreUpdate);

        this.state = {
            isComposerEmpty: true,
            composerContent: "",
            haveRecording: false,
            recordingTimeLeftSeconds: undefined, // when set to a number, shows a toast
            isMenuOpen: false,
            isStickerPickerOpen: false,
            showStickersButton: SettingsStore.getValue("MessageComposerInput.showStickersButton"),
            showPollsButton: SettingsStore.getValue("MessageComposerInput.showPollsButton"),
            showVoiceBroadcastButton: SettingsStore.getValue(Features.VoiceBroadcast),
            isWysiwygLabEnabled: SettingsStore.getValue<boolean>("feature_wysiwyg_composer"),
            isRichTextEnabled: true,
            initialComposerContent: "",
        };

        this.instanceId = instanceCount++;

        SettingsStore.monitorSetting("MessageComposerInput.showStickersButton", null);
        SettingsStore.monitorSetting("MessageComposerInput.showPollsButton", null);
        SettingsStore.monitorSetting(Features.VoiceBroadcast, null);
        SettingsStore.monitorSetting("feature_wysiwyg_composer", null);
    }

    private get voiceRecording(): Optional<VoiceMessageRecording> {
        return this._voiceRecording;
    }

    private set voiceRecording(rec: Optional<VoiceMessageRecording>) {
        if (this._voiceRecording) {
            this._voiceRecording.off(RecordingState.Started, this.onRecordingStarted);
            this._voiceRecording.off(RecordingState.EndingSoon, this.onRecordingEndingSoon);
        }

        this._voiceRecording = rec;

        if (rec) {
            // Delay saying we have a recording until it is started, as we might not yet
            // have A/V permissions
            rec.on(RecordingState.Started, this.onRecordingStarted);

            // We show a little heads up that the recording is about to automatically end soon. The 3s
            // display time is completely arbitrary.
            rec.on(RecordingState.EndingSoon, this.onRecordingEndingSoon);
        }
    }

    public componentDidMount() {
        this.dispatcherRef = dis.register(this.onAction);
        this.waitForOwnMember();
        UIStore.instance.trackElementDimensions(`MessageComposer${this.instanceId}`, this.ref.current!);
        UIStore.instance.on(`MessageComposer${this.instanceId}`, this.onResize);
        this.updateRecordingState(); // grab any cached recordings
    }

    private onResize = (type: UI_EVENTS, entry: ResizeObserverEntry) => {
        if (type === UI_EVENTS.Resize) {
            const { narrow } = this.context;
            this.setState({
                isMenuOpen: !narrow ? false : this.state.isMenuOpen,
                isStickerPickerOpen: false,
            });
        }
    };

    private onAction = (payload: ActionPayload) => {
        switch (payload.action) {
            case "reply_to_event":
                if (payload.context === this.context.timelineRenderingType) {
                    // add a timeout for the reply preview to be rendered, so
                    // that the ScrollPanel listening to the resizeNotifier can
                    // correctly measure it's new height and scroll down to keep
                    // at the bottom if it already is
                    window.setTimeout(() => {
                        this.props.resizeNotifier.notifyTimelineHeightChanged();
                    }, 100);
                }
                break;

            case Action.SettingUpdated: {
                const settingUpdatedPayload = payload as SettingUpdatedPayload;
                switch (settingUpdatedPayload.settingName) {
                    case "MessageComposerInput.showStickersButton": {
                        const showStickersButton = SettingsStore.getValue("MessageComposerInput.showStickersButton");
                        if (this.state.showStickersButton !== showStickersButton) {
                            this.setState({ showStickersButton });
                        }
                        break;
                    }
                    case "MessageComposerInput.showPollsButton": {
                        const showPollsButton = SettingsStore.getValue("MessageComposerInput.showPollsButton");
                        if (this.state.showPollsButton !== showPollsButton) {
                            this.setState({ showPollsButton });
                        }
                        break;
                    }
                    case Features.VoiceBroadcast: {
                        if (this.state.showVoiceBroadcastButton !== settingUpdatedPayload.newValue) {
                            this.setState({ showVoiceBroadcastButton: !!settingUpdatedPayload.newValue });
                        }
                        break;
                    }
                    case "feature_wysiwyg_composer": {
                        if (this.state.isWysiwygLabEnabled !== settingUpdatedPayload.newValue) {
                            this.setState({ isWysiwygLabEnabled: Boolean(settingUpdatedPayload.newValue) });
                        }
                        break;
                    }
                }
            }
        }
    };

    private waitForOwnMember() {
        // If we have the member already, do that
        const me = this.props.room.getMember(MatrixClientPeg.get().getUserId());
        if (me) {
            this.setState({ me });
            return;
        }
        // Otherwise, wait for member loading to finish and then update the member for the avatar.
        // The members should already be loading, and loadMembersIfNeeded
        // will return the promise for the existing operation
        this.props.room.loadMembersIfNeeded().then(() => {
            const me = this.props.room.getMember(MatrixClientPeg.get().getUserId());
            this.setState({ me });
        });
    }

    public componentWillUnmount() {
        VoiceRecordingStore.instance.off(UPDATE_EVENT, this.onVoiceStoreUpdate);
        dis.unregister(this.dispatcherRef);
        UIStore.instance.stopTrackingElementDimensions(`MessageComposer${this.instanceId}`);
        UIStore.instance.removeListener(`MessageComposer${this.instanceId}`, this.onResize);

        // clean up our listeners by setting our cached recording to falsy (see internal setter)
        this.voiceRecording = null;
    }

    private onTombstoneClick = (ev) => {
        ev.preventDefault();

        const replacementRoomId = this.context.tombstone.getContent()["replacement_room"];
        const replacementRoom = MatrixClientPeg.get().getRoom(replacementRoomId);
        let createEventId = null;
        if (replacementRoom) {
            const createEvent = replacementRoom.currentState.getStateEvents(EventType.RoomCreate, "");
            if (createEvent && createEvent.getId()) createEventId = createEvent.getId();
        }

        const viaServers = [this.context.tombstone.getSender().split(":").slice(1).join(":")];

        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            highlighted: true,
            event_id: createEventId,
            room_id: replacementRoomId,
            auto_join: true,
            // Try to join via the server that sent the event. This converts @something:example.org
            // into a server domain by splitting on colons and ignoring the first entry ("@something").
            via_servers: viaServers,
            metricsTrigger: "Tombstone",
            metricsViaKeyboard: ev.type !== "click",
        });
    };

    private renderPlaceholderText = () => {
        if (this.props.replyToEvent) {
            const replyingToThread = this.props.relation?.rel_type === THREAD_RELATION_TYPE.name;
            if (replyingToThread && this.props.e2eStatus) {
                return _t("Reply to encrypted thread…");
            } else if (replyingToThread) {
                return _t("Reply to thread…");
            } else if (this.props.e2eStatus) {
                return _t("Send an encrypted reply…");
            } else {
                return _t("Send a reply…");
            }
        } else {
            if (this.props.e2eStatus) {
                return _t("Send an encrypted message…");
            } else {
                return _t("Send a message…");
            }
        }
    };

    private addEmoji = (emoji: string): boolean => {
        dis.dispatch<ComposerInsertPayload>({
            action: Action.ComposerInsert,
            text: emoji,
            timelineRenderingType: this.context.timelineRenderingType,
        });
        return true;
    };

    private sendMessage = async () => {
        if (this.state.haveRecording && this.voiceRecordingButton.current) {
            // There shouldn't be any text message to send when a voice recording is active, so
            // just send out the voice recording.
            await this.voiceRecordingButton.current?.send();
            return;
        }

        this.messageComposerInput.current?.sendMessage();

        if (this.state.isWysiwygLabEnabled) {
            const { permalinkCreator, relation, replyToEvent } = this.props;
            await sendMessage(this.state.composerContent, this.state.isRichTextEnabled, {
                mxClient: this.props.mxClient,
                roomContext: this.context,
                permalinkCreator,
                relation,
                replyToEvent,
            });
            dis.dispatch({ action: Action.ClearAndFocusSendMessageComposer });
            this.setState({ composerContent: "", initialComposerContent: "" });
        }
    };

    private onChange = (model: EditorModel) => {
        this.setState({
            isComposerEmpty: model.isEmpty,
        });
    };

    private onWysiwygChange = (content: string) => {
        this.setState({
            composerContent: content,
            isComposerEmpty: content?.length === 0,
        });
    };

    private onRichTextToggle = async () => {
        const { richToPlain, plainToRich } = await getConversionFunctions();

        const { isRichTextEnabled, composerContent } = this.state;
        const convertedContent = isRichTextEnabled
            ? await richToPlain(composerContent)
            : await plainToRich(composerContent);

        this.setState({
            isRichTextEnabled: !isRichTextEnabled,
            composerContent: convertedContent,
            initialComposerContent: convertedContent,
        });
    };

    private onVoiceStoreUpdate = () => {
        this.updateRecordingState();
    };

    private updateRecordingState() {
        const voiceRecordingId = VoiceRecordingStore.getVoiceRecordingId(this.props.room, this.props.relation);
        this.voiceRecording = VoiceRecordingStore.instance.getActiveRecording(voiceRecordingId);
        if (this.voiceRecording) {
            // If the recording has already started, it's probably a cached one.
            if (this.voiceRecording.hasRecording && !this.voiceRecording.isRecording) {
                this.setState({ haveRecording: true });
            }

            // Note: Listeners for recording states are set by the `this.voiceRecording` setter.
        } else {
            this.setState({ haveRecording: false });
        }
    }

    private onRecordingStarted = () => {
        // update the recording instance, just in case
        const voiceRecordingId = VoiceRecordingStore.getVoiceRecordingId(this.props.room, this.props.relation);
        this.voiceRecording = VoiceRecordingStore.instance.getActiveRecording(voiceRecordingId);
        this.setState({
            haveRecording: !!this.voiceRecording,
        });
    };

    private onRecordingEndingSoon = ({ secondsLeft }) => {
        this.setState({ recordingTimeLeftSeconds: secondsLeft });
        window.setTimeout(() => this.setState({ recordingTimeLeftSeconds: null }), 3000);
    };

    private setStickerPickerOpen = (isStickerPickerOpen: boolean) => {
        this.setState({
            isStickerPickerOpen,
            isMenuOpen: false,
        });
    };

    private toggleStickerPickerOpen = () => {
        this.setStickerPickerOpen(!this.state.isStickerPickerOpen);
    };

    private toggleButtonMenu = (): void => {
        this.setState({
            isMenuOpen: !this.state.isMenuOpen,
        });
    };

    private get showStickersButton(): boolean {
        return this.state.showStickersButton && !isLocalRoom(this.props.room);
    }

    private getMenuPosition() {
        if (this.ref.current) {
            const hasFormattingButtons = this.state.isWysiwygLabEnabled && this.state.isRichTextEnabled;
            const contentRect = this.ref.current.getBoundingClientRect();
            // Here we need to remove the all the extra space above the editor
            // Instead of doing a querySelector or pass a ref to find the compute the height formatting buttons
            // We are using an arbitrary value, the formatting buttons height doesn't change during the lifecycle of the component
            // It's easier to just use a constant here instead of an over-engineering way to find the height
            const heightToRemove = hasFormattingButtons ? 36 : 0;
            const fixedRect = new DOMRect(
                contentRect.x,
                contentRect.y + heightToRemove,
                contentRect.width,
                contentRect.height - heightToRemove,
            );
            return aboveLeftOf(fixedRect);
        }
    }

    public render() {
        const hasE2EIcon = Boolean(!this.state.isWysiwygLabEnabled && this.props.e2eStatus);
        const e2eIcon = hasE2EIcon && (
            <E2EIcon key="e2eIcon" status={this.props.e2eStatus} className="mx_MessageComposer_e2eIcon" />
        );

        const controls: ReactNode[] = [];
        const menuPosition = this.getMenuPosition();

        const canSendMessages = this.context.canSendMessages && !this.context.tombstone;
        let composer: ReactNode;
        if (canSendMessages) {
            if (this.state.isWysiwygLabEnabled && menuPosition) {
                composer = (
                    <SendWysiwygComposer
                        key="controls_input"
                        disabled={this.state.haveRecording}
                        onChange={this.onWysiwygChange}
                        onSend={this.sendMessage}
                        isRichTextEnabled={this.state.isRichTextEnabled}
                        initialContent={this.state.initialComposerContent}
                        e2eStatus={this.props.e2eStatus}
                        menuPosition={menuPosition}
                        placeholder={this.renderPlaceholderText()}
                    />
                );
            } else {
                composer = (
                    <SendMessageComposer
                        ref={this.messageComposerInput}
                        key="controls_input"
                        room={this.props.room}
                        placeholder={this.renderPlaceholderText()}
                        permalinkCreator={this.props.permalinkCreator}
                        relation={this.props.relation}
                        replyToEvent={this.props.replyToEvent}
                        onChange={this.onChange}
                        disabled={this.state.haveRecording}
                        toggleStickerPickerOpen={this.toggleStickerPickerOpen}
                    />
                );
            }

            controls.push(
                <VoiceRecordComposerTile
                    key="controls_voice_record"
                    ref={this.voiceRecordingButton}
                    room={this.props.room}
                    permalinkCreator={this.props.permalinkCreator}
                    relation={this.props.relation}
                    replyToEvent={this.props.replyToEvent}
                />,
            );
        } else if (this.context.tombstone) {
            const replacementRoomId = this.context.tombstone.getContent()["replacement_room"];

            const continuesLink = replacementRoomId ? (
                <a
                    href={makeRoomPermalink(replacementRoomId)}
                    className="mx_MessageComposer_roomReplaced_link"
                    onClick={this.onTombstoneClick}
                >
                    {_t("The conversation continues here.")}
                </a>
            ) : (
                ""
            );

            controls.push(
                <div className="mx_MessageComposer_replaced_wrapper" key="room_replaced">
                    <div className="mx_MessageComposer_replaced_valign">
                        <img
                            className="mx_MessageComposer_roomReplaced_icon"
                            src={require("../../../../res/img/room_replaced.svg").default}
                        />
                        <span className="mx_MessageComposer_roomReplaced_header">
                            {_t("This room has been replaced and is no longer active.")}
                        </span>
                        <br />
                        {continuesLink}
                    </div>
                </div>,
            );
        } else {
            controls.push(
                <div key="controls_error" className="mx_MessageComposer_noperm_error">
                    {_t("You do not have permission to post to this room")}
                </div>,
            );
        }

        let recordingTooltip;
        if (this.state.recordingTimeLeftSeconds) {
            const secondsLeft = Math.round(this.state.recordingTimeLeftSeconds);
            recordingTooltip = (
                <Tooltip label={_t("%(seconds)ss left", { seconds: secondsLeft })} alignment={Alignment.Top} />
            );
        }

        const threadId =
            this.props.relation?.rel_type === THREAD_RELATION_TYPE.name ? this.props.relation.event_id : null;

        controls.push(
            <Stickerpicker
                room={this.props.room}
                threadId={threadId}
                isStickerPickerOpen={this.state.isStickerPickerOpen}
                setStickerPickerOpen={this.setStickerPickerOpen}
                menuPosition={menuPosition}
                key="stickers"
            />,
        );

        const showSendButton = !this.state.isComposerEmpty || this.state.haveRecording;

        const classes = classNames({
            "mx_MessageComposer": true,
            "mx_MessageComposer--compact": this.props.compact,
            "mx_MessageComposer_e2eStatus": hasE2EIcon,
            "mx_MessageComposer_wysiwyg": this.state.isWysiwygLabEnabled,
        });

        return (
            <div className={classes} ref={this.ref}>
                {recordingTooltip}
                <div className="mx_MessageComposer_wrapper">
                    <ReplyPreview
                        replyToEvent={this.props.replyToEvent}
                        permalinkCreator={this.props.permalinkCreator}
                    />
                    <div className="mx_MessageComposer_row">
                        {e2eIcon}
                        {composer}
                        <div className="mx_MessageComposer_actions">
                            {controls}
                            {canSendMessages && (
                                <MessageComposerButtons
                                    addEmoji={this.addEmoji}
                                    haveRecording={this.state.haveRecording}
                                    isMenuOpen={this.state.isMenuOpen}
                                    isStickerPickerOpen={this.state.isStickerPickerOpen}
                                    menuPosition={menuPosition}
                                    relation={this.props.relation}
                                    onRecordStartEndClick={() => {
                                        this.voiceRecordingButton.current?.onRecordStartEndClick();
                                        if (this.context.narrow) {
                                            this.toggleButtonMenu();
                                        }
                                    }}
                                    setStickerPickerOpen={this.setStickerPickerOpen}
                                    showLocationButton={!window.electron}
                                    showPollsButton={this.state.showPollsButton}
                                    showStickersButton={this.showStickersButton}
                                    isRichTextEnabled={this.state.isRichTextEnabled}
                                    onComposerModeClick={this.onRichTextToggle}
                                    toggleButtonMenu={this.toggleButtonMenu}
                                    showVoiceBroadcastButton={this.state.showVoiceBroadcastButton}
                                    onStartVoiceBroadcastClick={() => {
                                        setUpVoiceBroadcastPreRecording(
                                            this.props.room,
                                            MatrixClientPeg.get(),
                                            SdkContextClass.instance.voiceBroadcastPlaybacksStore,
                                            SdkContextClass.instance.voiceBroadcastRecordingsStore,
                                            SdkContextClass.instance.voiceBroadcastPreRecordingStore,
                                        );
                                        this.toggleButtonMenu();
                                    }}
                                />
                            )}
                            {showSendButton && (
                                <SendButton
                                    key="controls_send"
                                    onClick={this.sendMessage}
                                    title={this.state.haveRecording ? _t("Send voice message") : undefined}
                                />
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }
}

const MessageComposerWithMatrixClient = withMatrixClientHOC(MessageComposer);
export default MessageComposerWithMatrixClient;
