import { Test, TestingModule } from '@nestjs/testing';
import { VariantTemplatesController } from './variant-templates.controller';
import { VariantTemplatesService } from './variant-templates.service';

describe('VariantTemplatesController', () => {
  let controller: VariantTemplatesController;
  const service = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VariantTemplatesController],
      providers: [{ provide: VariantTemplatesService, useValue: service }],
    }).compile();

    controller = module.get<VariantTemplatesController>(
      VariantTemplatesController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates update to the service', async () => {
    service.update.mockResolvedValue({ data: { id: 't1' } });

    await controller.update('t1', { name: 'New' });

    expect(service.update).toHaveBeenCalledWith('t1', { name: 'New' });
  });
});
