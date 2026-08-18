import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  fallback: ReactNode;
};

type State = {
  failed: boolean;
};

export class LocalAudioErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error("[OwnMinutes] Local audio player failed", error.name || "AudioPlayerError");
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
