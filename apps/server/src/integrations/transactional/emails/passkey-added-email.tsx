import { Section, Text } from '../components';
import * as React from 'react';
import { content, paragraph } from '../css/styles';
import { MailBody } from '../partials/partials';

interface Props {
  username?: string;
  passkeyName: string;
  addedAt: string;
}

export const PasskeyAddedEmail = ({
  username,
  passkeyName,
  addedAt,
}: Props) => {
  return (
    <MailBody>
      <Section style={content}>
        <Text style={paragraph}>Hi {username},</Text>
        <Text style={paragraph}>
          A passkey named "{passkeyName}" was added to your account on {addedAt}
          .
        </Text>
        <Text style={paragraph}>
          If this was not you, change your password and remove the passkey in
          your account settings.
        </Text>
      </Section>
    </MailBody>
  );
};

export default PasskeyAddedEmail;
