import { useMutation } from '@tanstack/react-query';
import { OrderedSet as ImmutableOrderedSet } from 'immutable';
import React, { MutableRefObject, useRef, useState } from 'react';
import { useIntl, defineMessages } from 'react-intl';

import {
  sendChatMessage,
  markChatRead,
} from 'soapbox/actions/chats';
import { uploadMedia } from 'soapbox/actions/media';
import { openModal } from 'soapbox/actions/modals';
import { initReport } from 'soapbox/actions/reports';
import { Avatar, Button, HStack, Icon, IconButton, Input, Stack, Text, Textarea } from 'soapbox/components/ui';
import UploadProgress from 'soapbox/components/upload-progress';
import UploadButton from 'soapbox/features/compose/components/upload_button';
import { useAppSelector, useAppDispatch, useOwnAccount } from 'soapbox/hooks';
import { IChat, useChat } from 'soapbox/queries/chats';
import { queryClient } from 'soapbox/queries/client';
import { truncateFilename } from 'soapbox/utils/media';

import ChatMessageList from './chat-message-list';

const messages = defineMessages({
  placeholder: { id: 'chat_box.input.placeholder', defaultMessage: 'Type a message' },
  send: { id: 'chat_box.actions.send', defaultMessage: 'Send' },
});

const fileKeyGen = (): number => Math.floor((Math.random() * 0x10000));

interface IChatBox {
  chat: IChat,
  onSetInputRef: (el: HTMLTextAreaElement) => void,
  autosize?: boolean,
  inputRef?: MutableRefObject<HTMLTextAreaElement>
}

/**
 * Chat UI with just the messages and textarea.
 * Reused between floating desktop chats and fullscreen/mobile chats.
 */
const ChatBox: React.FC<IChatBox> = ({ chat, onSetInputRef, autosize, inputRef }) => {
  const intl = useIntl();
  const dispatch = useAppDispatch();
  const chatMessageIds = useAppSelector(state => state.chat_message_lists.get(chat.id, ImmutableOrderedSet<string>()));
  const account = useOwnAccount();

  const { createChatMessage, markChatAsRead, acceptChat, deleteChat } = useChat(chat.id);

  const [content, setContent] = useState<string>('');
  const [attachment, setAttachment] = useState<any>(undefined);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [resetFileKey, setResetFileKey] = useState<number>(fileKeyGen());

  const inputElem = useRef<HTMLTextAreaElement | null>(null);

  const needsAcceptance = !chat.accepted && chat.created_by_account !== account?.id;

  const isSubmitDisabled = content.length === 0 && !attachment;

  // TODO: needs last_read_id param
  const markAsRead = useMutation(() => markChatAsRead(), {
    onSuccess: () => {
      queryClient.invalidateQueries(['chats']);
    },
  });

  const submitMessage = useMutation(({ chatId, content }: any) => {
    return createChatMessage(chatId, content);
  }, {
    onMutate: async (newMessage) => {
      clearState();

      // Cancel any outgoing refetches (so they don't overwrite our optimistic update)
      await queryClient.cancelQueries(['chats', 'messages', chat.id]);

      // Snapshot the previous value
      const previousChatMessages = queryClient.getQueryData(['chats', 'messages', chat.id]);

      // Optimistically update to the new value
      queryClient.setQueryData(['chats', 'messages', chat.id], (prevResult: any) => {
        const newResult = prevResult;
        newResult.pages = prevResult.pages.map((page: any, idx: number) => {
          if (idx === 0) {
            return {
              ...page,
              result: [...page.result, {
                ...newMessage,
                id: String(Number(new Date())),
                created_at: new Date(),
                account_id: account?.id,
                pending: true,
              }],
            };
          }

          return page;
        });

        return newResult;
      });

      // Return a context object with the snapshotted value
      return { previousChatMessages };
    },
    // If the mutation fails, use the context returned from onMutate to roll back
    onError: (err, newTodo, context: any) => {
      queryClient.setQueryData(['chats', 'messages', chat.id], context.previousChatMessages);
    },
    // Always refetch after error or success:
    onSettled: () => {
      queryClient.invalidateQueries(['chats', 'messages', chat.id]);
    },
  });

  const clearState = () => {
    setContent('');
    setAttachment(undefined);
    setIsUploading(false);
    setUploadProgress(0);
    setResetFileKey(fileKeyGen());
  };

  const sendMessage = () => {
    if (!isSubmitDisabled && !submitMessage.isLoading) {
      const params = {
        content,
        media_id: attachment && attachment.id,
      };

      submitMessage.mutate({ chatId: chat.id, content });
      acceptChat.mutate();
    }
  };

  const insertLine = () => setContent(content + '\n');

  const handleKeyDown: React.KeyboardEventHandler = (event) => {
    markRead();

    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      insertLine();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      sendMessage();
    }
  };

  const handleContentChange: React.ChangeEventHandler<HTMLTextAreaElement> = (event) => {
    setContent(event.target.value);
  };

  const handlePaste: React.ClipboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (isSubmitDisabled && e.clipboardData && e.clipboardData.files.length === 1) {
      handleFiles(e.clipboardData.files);
    }
  };

  const markRead = () => {
    // markAsRead.mutate();
    // dispatch(markChatRead(chatId));
  };

  const handleMouseOver = () => markRead();

  const handleRemoveFile = () => {
    setAttachment(undefined);
    setResetFileKey(fileKeyGen());
  };

  const onUploadProgress = (e: ProgressEvent) => {
    const { loaded, total } = e;
    setUploadProgress(loaded / total);
  };

  const handleFiles = (files: FileList) => {
    setIsUploading(true);

    const data = new FormData();
    data.append('file', files[0]);

    dispatch(uploadMedia(data, onUploadProgress)).then((response: any) => {
      setAttachment(response.data);
      setIsUploading(false);
    }).catch(() => {
      setIsUploading(false);
    });
  };

  const handleLeaveChat = () => {
    dispatch(openModal('CONFIRM', {
      heading: 'Leave Chat',
      message: 'Are you sure you want to leave this chat? This conversation will be removed from your inbox.',
      confirm: 'Leave Chat',
      confirmationTheme: 'primary',
      onConfirm: () => {
        deleteChat.mutate();
      },
    }));
  };

  const handleReportChat = () => {
    dispatch(initReport(chat.account));
    acceptChat.mutate();
  };

  const renderAttachment = () => {
    if (!attachment) return null;

    return (
      <div className='chat-box__attachment'>
        <div className='chat-box__filename'>
          {truncateFilename(attachment.preview_url, 20)}
        </div>
        <div className='chat-box__remove-attachment'>
          <IconButton
            src={require('@tabler/icons/x.svg')}
            onClick={handleRemoveFile}
          />
        </div>
      </div>
    );
  };

  const renderActionButton = () => {
    // return canSubmit() ? (
    //   <IconButton
    //     src={require('@tabler/icons/send.svg')}
    //     title={intl.formatMessage(messages.send)}
    //     onClick={sendMessage}
    //   />
    // ) : (
    //   <UploadButton onSelectFile={handleFiles} resetFileKey={resetFileKey} />
    // );
  };

  if (!chatMessageIds) return null;

  return (
    <Stack className='overflow-hidden flex flex-grow' onMouseOver={handleMouseOver}>
      <div className='flex-grow h-full overflow-hidden flex justify-center'>
        {needsAcceptance ? (
          <Stack justifyContent='center' alignItems='center' space={5} className='w-3/4 mx-auto'>
            <Stack alignItems='center' space={2}>
              <Avatar src={chat.account.avatar_static} size={75} />
              <Text size='lg' align='center'>
                <Text tag='span' weight='semibold'>@{chat.account.acct}</Text>
                {' '}
                <Text tag='span'>wants to start a chat with you</Text>
              </Text>
            </Stack>

            <Stack space={2} className='w-full'>
              <Button
                theme='primary'
                block
                onClick={() => {
                  acceptChat.mutate();
                  inputRef?.current?.focus();
                }}
                disabled={acceptChat.isLoading}
              >
                Accept
              </Button>

              <HStack alignItems='center' space={2} className='w-full'>
                <Button
                  theme='accent'
                  block
                  onClick={handleLeaveChat}
                >
                  Leave chat
                </Button>

                <Button
                  theme='secondary'
                  block
                  onClick={handleReportChat}
                >
                  Report
                </Button>
              </HStack>
            </Stack>
          </Stack>
        ) : (
          <ChatMessageList chatMessageIds={chatMessageIds} chat={chat} autosize />
        )}
      </div>

      <div className='mt-auto p-4 shadow-3xl'>
        <HStack alignItems='center' justifyContent='between' space={4}>
          <div className='flex-grow'>
            <Textarea
              rows={1}
              autoFocus
              ref={inputRef}
              placeholder={intl.formatMessage(messages.placeholder)}
              onKeyDown={handleKeyDown}
              value={content}
              onChange={handleContentChange}
              isResizeable={false}
            />
          </div>

          <IconButton
            src={require('@tabler/icons/send.svg')}
            iconClassName='w-5 h-5'
            className='text-primary-500'
            disabled={isSubmitDisabled}
            onClick={sendMessage}
          />
        </HStack>
      </div>
    </Stack>
    //   {renderAttachment()}
    //   {isUploading && (
    //     <UploadProgress progress={uploadProgress * 100} />
    //   )}
    //   <div className='chat-box__actions simple_form'>
    //     <div className='chat-box__send'>
    //       {renderActionButton()}
    //     </div>
    //     <textarea
    //       rows={1}
    //
    //
    //       onPaste={handlePaste}
    //       value={content}
    //       ref={setInputRef}
    //     />
    //   </div>
    // </div>
  );
};

export default ChatBox;
