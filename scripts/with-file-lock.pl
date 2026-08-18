#!/usr/bin/env perl

use strict;
use warnings;
use Fcntl qw(:DEFAULT :flock F_GETFD F_SETFD FD_CLOEXEC);

my ($lock_path, $timeout_seconds, @command) = @ARGV;
my $held_environment = "OWNMINUTES_SECRET_AUDIT_LOCK_HELD";
if (@command && $command[0] =~ /^--held-env=([A-Z][A-Z0-9_]*)$/) {
  $held_environment = $1;
  shift @command;
}
if (
  !defined($lock_path) ||
  $lock_path !~ m{^/} ||
  $lock_path =~ /\0/ ||
  !defined($timeout_seconds) ||
  $timeout_seconds !~ /^\d+$/ ||
  $timeout_seconds < 1 ||
  $timeout_seconds > 120 ||
  $held_environment !~ /^OWNMINUTES_(?:SECRET_AUDIT|STACK_OPERATION|BACKUP_OPERATION)_LOCK_HELD$/ ||
  !@command
) {
  print STDERR "file_lock_invalid_arguments\n";
  exit 64;
}

my $no_follow = eval { Fcntl::O_NOFOLLOW() } || 0;
my $lock_handle;
if (!sysopen($lock_handle, $lock_path, O_RDWR | O_CREAT | $no_follow, 0600)) {
  print STDERR "file_lock_open_failed\n";
  exit 74;
}
chmod 0600, $lock_path;

my $timed_out = 0;
my $lock_error = "";
{
  local $SIG{ALRM} = sub {
    $timed_out = 1;
    die "file_lock_timeout\n";
  };
  alarm $timeout_seconds;
  eval {
    flock($lock_handle, LOCK_EX) or die "file_lock_acquire_failed\n";
  };
  $lock_error = $@;
  alarm 0;
}

if ($lock_error) {
  close $lock_handle;
  print STDERR ($timed_out ? "file_lock_timeout\n" : "file_lock_acquire_failed\n");
  exit($timed_out ? 75 : 74);
}

my @handle_stats = stat($lock_handle);
my @path_stats = lstat($lock_path);
if (
  !@handle_stats ||
  !@path_stats ||
  -l $lock_path ||
  !-f $lock_path ||
  $handle_stats[0] != $path_stats[0] ||
  $handle_stats[1] != $path_stats[1]
) {
  flock($lock_handle, LOCK_UN);
  close $lock_handle;
  print STDERR "file_lock_unsafe_target\n";
  exit 74;
}

my $descriptor_flags = fcntl($lock_handle, F_GETFD, 0);
if (
  !defined($descriptor_flags) ||
  !defined(fcntl($lock_handle, F_SETFD, $descriptor_flags & ~FD_CLOEXEC))
) {
  flock($lock_handle, LOCK_UN);
  close $lock_handle;
  print STDERR "file_lock_inherit_failed\n";
  exit 74;
}

my $descriptor_environment = $held_environment;
$descriptor_environment =~ s/_HELD$/_FD/;
$ENV{$held_environment} = "1";
$ENV{$descriptor_environment} = fileno($lock_handle);
$ENV{"OWNMINUTES_FILE_LOCK_FD"} = fileno($lock_handle);

# Replace the wrapper instead of forking a child. The protected command owns the
# same kernel lock descriptor and forwards it to any state-mutating descendants.
{
  no warnings "exec";
  exec { $command[0] } @command;
}

flock($lock_handle, LOCK_UN);
close $lock_handle;
print STDERR "file_lock_child_start_failed\n";
exit 74;
