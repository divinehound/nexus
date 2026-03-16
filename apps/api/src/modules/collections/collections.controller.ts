import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CollectionsService } from './collections.service';

@ApiTags('collections')
@Controller('collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get collection by ID' })
  findById(@Param('id') id: string) {
    return this.collectionsService.findById(id);
  }

  @Get('address/:address')
  @ApiOperation({ summary: 'Get collection by contract address' })
  findByAddress(@Param('address') address: string) {
    return this.collectionsService.findByAddress(address);
  }
}
