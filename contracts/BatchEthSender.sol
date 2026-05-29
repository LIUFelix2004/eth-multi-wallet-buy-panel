// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BatchEthSender {
    error NoRecipients();
    error WrongValue();
    error TransferFailed(address recipient);

    function sendEqual(address payable[] calldata recipients, uint256 amountEach) external payable {
        uint256 count = recipients.length;
        if (count == 0) revert NoRecipients();
        if (msg.value != amountEach * count) revert WrongValue();

        for (uint256 i = 0; i < count; i++) {
            (bool ok, ) = recipients[i].call{value: amountEach}("");
            if (!ok) revert TransferFailed(recipients[i]);
        }
    }
}
